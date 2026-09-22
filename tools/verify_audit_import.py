"""Regression checks for ONNX import semantics found during the program audit.

Run: py -3 -B tools/verify_audit_import.py
All ONNX and .nforge files are created in temporary directories and removed.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnx.reference import ReferenceEvaluator

import import_model
import nforge
from verify_import import ir_forward


def tensor(name, values):
    return numpy_helper.from_array(np.asarray(values, dtype=np.float32), name)


def model(nodes, initializers, input_shape, output_shape):
    graph = helper.make_graph(
        nodes, "audit_import",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, input_shape)],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, output_shape)],
        initializers,
    )
    result = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    onnx.checker.check_model(result)
    return result


class ImportAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nf-import-audit-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def roundtrip(self, original, blocks="auto"):
        source = self.directory / "model.onnx"
        target = self.directory / "model.nforge"
        onnx.save_model(original, source)
        opts = SimpleNamespace(
            model=str(source), max_neurons=500000, max_edges=2000000,
            spacing=26.0, names=False, prune_below=0.0, blocks=blocks,
        )
        builder, _ = import_model.import_onnx(source, opts)
        neurons, edges, dense, _ = import_model.build_arrays(builder, opts)
        self.assertEqual(len(neurons.bias), len(neurons))
        nforge.write(target, neurons, edges, blocks=dense,
                     ops=import_model.build_ops(builder), source=builder.source)
        header, read_neurons, read_edges, read_dense = nforge.read(target)
        self.assertEqual(nforge.check_index(header), [])
        return builder, read_neurons, read_edges, read_dense, nforge.read_ops(target)

    def assert_scalar_forward(self, original, inputs, blocks="auto"):
        builder, neurons, edges, dense, _ = self.roundtrip(original, blocks)
        expected = ReferenceEvaluator(original).run(None, {"X": inputs})[0].reshape(-1)
        actual = ir_forward(neurons, edges, inputs, builder.out_ids, dense)
        np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-6)

    def test_add_after_nonlinear_activation_keeps_operation_order(self):
        for activation in ("Relu", "Sigmoid", "Tanh"):
            for blocks in ("never", "always"):
                with self.subTest(activation=activation, blocks=blocks):
                    original = model([
                        helper.make_node("MatMul", ["X", "W"], ["Z"]),
                        helper.make_node(activation, ["Z"], ["R"]),
                        helper.make_node("Add", ["R", "B"], ["Y"]),
                    ], [tensor("W", np.eye(2)), tensor("B", [1, -1])], [1, 2], [1, 2])
                    self.assert_scalar_forward(original, np.array([[-2, 2]], np.float32), blocks)

    def test_gemm_broadcasts_scalar_and_singleton_bias(self):
        for bias in (np.array(1), np.array([1]), np.array([[1]]), np.array([1, 2])):
            for blocks in ("never", "always"):
                with self.subTest(bias_shape=bias.shape, blocks=blocks):
                    original = model([
                        helper.make_node("Gemm", ["X", "W", "B"], ["Y"], beta=2.0),
                    ], [tensor("W", np.eye(2)), tensor("B", bias)], [1, 2], [1, 2])
                    self.assert_scalar_forward(original, np.ones((1, 2), np.float32), blocks)

    def test_add_broadcasts_scalar_with_and_without_a_previous_layer(self):
        for preceding_layer in (False, True):
            with self.subTest(preceding_layer=preceding_layer):
                nodes = [helper.make_node("MatMul", ["X", "W"], ["Z"])] if preceding_layer else []
                nodes.append(helper.make_node("Add", ["Z" if preceding_layer else "X", "B"], ["Y"]))
                inits = [tensor("B", 1)] + ([tensor("W", np.eye(2))] if preceding_layer else [])
                self.assert_scalar_forward(model(nodes, inits, [1, 2], [1, 2]),
                                           np.array([[-2, 2]], np.float32))

    def test_tiled_tied_weights_preserve_each_region_after_file_roundtrip(self):
        # Real tile threshold: a 2048 x 2048 initializer is split into four
        # equally sized, deliberately different regions at each use site.
        weights = np.empty((2048, 2048), dtype=np.float32)
        weights[:1024, :1024] = 1
        weights[:1024, 1024:] = 2
        weights[1024:, :1024] = 3
        weights[1024:, 1024:] = 4
        original = model([
            helper.make_node("MatMul", ["X", "W"], ["A"]),
            helper.make_node("MatMul", ["A", "W"], ["Y"]),
        ], [tensor("W", weights)], [1, 2048], [1, 2048])
        builder, neurons, edges, dense, _ = self.roundtrip(original)
        self.assertEqual(len(edges), 0)
        self.assertEqual(len(dense), 8)
        self.assertEqual(len(set(dense.sg.tolist())), 4)
        self.assertTrue(np.all(dense.sg > 0))
        np.testing.assert_array_equal(dense.sg[:4], dense.sg[4:])
        self.assertEqual(dense.stored_weights, weights.size)
        weight_offsets, source_offsets, destination_offsets = dense.offsets
        for i, expected_value in enumerate([1, 2, 3, 4, 1, 2, 3, 4]):
            np.testing.assert_array_equal(
                dense.w[weight_offsets[i]:weight_offsets[i + 1]], expected_value)

        # Evaluate the saved tiled matrices without expanding millions of edges.
        inputs = np.linspace(-0.5, 1, 2048, dtype=np.float32).reshape(1, -1)
        values = np.zeros(len(neurons), dtype=np.float64)
        values[np.flatnonzero(neurons.io & nforge.IO_IN)] = inputs.reshape(-1)
        for i in range(len(dense)):
            src = dense.src[source_offsets[i]:source_offsets[i + 1]]
            dst = dense.dst[destination_offsets[i]:destination_offsets[i + 1]]
            weight = dense.w[weight_offsets[i]:weight_offsets[i + 1]].reshape(len(src), len(dst))
            values[dst] += values[src] @ weight
        expected = ReferenceEvaluator(original).run(None, {"X": inputs})[0].reshape(-1)
        np.testing.assert_allclose(values[builder.out_ids[0]], expected, rtol=1e-5, atol=1e-4)

    def test_square_weight_transpose_uses_separate_parameter_groups(self):
        # Shape alone cannot distinguish a square initializer from its transpose.
        weights = np.array([[1, 2], [3, 4]], dtype=np.float32)
        original = model([
            helper.make_node("Gemm", ["X", "W"], ["A"]),
            helper.make_node("Gemm", ["A", "W"], ["Y"], transB=1),
        ], [tensor("W", weights)], [1, 2], [1, 2])
        self.assert_scalar_forward(original, np.array([[1, 2]], np.float32), "always")

    def test_pooling_omitted_and_explicit_strides_preserve_shape_and_values(self):
        for operator in ("MaxPool", "AveragePool"):
            for strides in (None, [2, 2]):
                with self.subTest(operator=operator, strides=strides):
                    attrs = {"kernel_shape": [2, 2]}
                    if strides is not None:
                        attrs["strides"] = strides
                    shape = [1, 1, 2, 2] if strides is None else [1, 1, 1, 1]
                    original = model([helper.make_node(operator, ["X"], ["Y"], **attrs)],
                                     [], [1, 1, 3, 3], shape)
                    _, _, _, _, saved_ops = self.roundtrip(original)
                    saved = saved_ops.list[0]
                    self.assertEqual(saved.attrs["strides"], strides or [1, 1])
                    restored_attrs = dict(saved.attrs)
                    if operator == "MaxPool":
                        restored_attrs.pop("count_include_pad")
                    restored = model([
                        helper.make_node(operator, ["X"], ["Y"], **restored_attrs),
                    ], [], [1, 1, 3, 3], saved.out)
                    inputs = np.arange(9, dtype=np.float32).reshape(1, 1, 3, 3)
                    expected = ReferenceEvaluator(original).run(None, {"X": inputs})[0]
                    actual = ReferenceEvaluator(restored).run(None, {"X": inputs})[0]
                    self.assertEqual(list(actual.shape), saved.out)
                    np.testing.assert_allclose(actual, expected)


if __name__ == "__main__":
    print("ONNX audit regressions; generated files are confined to temporary directories.", flush=True)
    unittest.main(verbosity=2)
