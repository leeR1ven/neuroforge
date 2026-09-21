import fs from 'node:fs';
const html = fs.readFileSync('prototype/template.html', 'utf8');
let js = fs.readFileSync('prototype/dist/bundle.js', 'utf8');
js = js.replace(/<\/script/gi, '<\\/script');
const out = html.replace('<script src="./dist/bundle.js"></script>', '<script>\n' + js + '\n</script>');
if (out === html) throw new Error('未找到打包脚本占位符');
fs.writeFileSync('prototype/神经元编辑器原型.html', out);
fs.writeFileSync('prototype/index.html', out);
console.log('已生成单文件原型: ' + (Buffer.byteLength(out) / 1024 / 1024).toFixed(2) + ' MB');
