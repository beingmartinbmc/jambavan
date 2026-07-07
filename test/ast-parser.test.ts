import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ASTParser } from '../src/index/ast-parser';
import { mkTempConfig } from '../test-support/config';

test('ASTParser: TypeScript class methods and public fields are indexed', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'class.ts');
    fs.writeFileSync(file, 'class A {\n  foo() {}\n  bar = () => {}\n}\nfunction top() {}\n');
    const names = new ASTParser().parseFile(file).symbols.map(s => s.name).sort();
    assert.deepEqual(names, ['A', 'bar', 'foo', 'top']);
  } finally { cleanup(); }
});

test('ASTParser: JavaScript class methods and fields are indexed', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'class.js');
    fs.writeFileSync(file, 'class A {\n  foo() {}\n  bar = () => {}\n}\nfunction top() {}\n');
    const names = new ASTParser().parseFile(file).symbols.map(s => s.name).sort();
    assert.deepEqual(names, ['A', 'bar', 'foo', 'top']);
  } finally { cleanup(); }
});

test('ASTParser: reports support, unknown files, and diagnostics', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const unknown = path.join(root, 'notes.txt');
    fs.writeFileSync(unknown, 'function ignored() {}');
    assert.equal(ASTParser.canParse('file.tsx'), true);
    assert.equal(ASTParser.canParse('file.txt'), false);
    assert.ok(ASTParser.supportedExtensions().includes('ts'));
    assert.deepEqual(new ASTParser().parseFile(unknown), { filePath: unknown, symbols: [], language: 'unknown', reExports: [] });
    assert.ok(ASTParser.diagnostics().some(d => d.language === 'typescript' && ['tree-sitter', 'regex'].includes(d.backend)));
  } finally { cleanup(); }
});

test('ASTParser: TypeScript references include imports, heritage, calls, and no self refs', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'refs.ts');
    fs.writeFileSync(file, [
      'import { helper } from "./helper";',
      'interface Base {}',
      'class Child extends Base {',
      '  run() { return this.work(helper()); }',
      '  work(value: unknown) { return value; }',
      '}',
      'export function helper() { return helper; }',
    ].join('\n'));
    const parsed = new ASTParser().parseFile(file);
    const child = parsed.symbols.find(s => s.name === 'Child');
    const run = parsed.symbols.find(s => s.name === 'run');
    const helperSym = parsed.symbols.find(s => s.name === 'helper');
    assert.equal(parsed.language, 'typescript');
    assert.ok(child?.references?.some(r => r.name === 'Base' && r.type === 'implements'));
    assert.ok(run?.references?.some(r => r.name === 'helper' && r.type === 'call'));
    assert.ok(run?.references?.some(r => r.name === 'work' && r.type === 'call'));
    assert.ok(!helperSym?.references?.some(r => r.name === 'helper'));
  } finally { cleanup(); }
});

test('ASTParser: Python decorated definitions are indexed', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'mod.py');
    fs.writeFileSync(file, '@decorator\ndef fn():\n    return 1\n\nclass Klass:\n    def method(self):\n        return fn()\n');
    const names = new ASTParser().parseFile(file).symbols.map(s => s.name).sort();
    assert.deepEqual(names, ['Klass', 'fn', 'method']);
  } finally { cleanup(); }
});

test('ASTParser: exported declarations keep their real kind, not "export"', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'exp.ts');
    fs.writeFileSync(file, 'export class A {}\nexport function f() {}\nexport interface I {}\nexport const g = () => {};\n');
    const byName = new Map(new ASTParser().parseFile(file).symbols.map(s => [s.name, s.type]));
    assert.equal(byName.get('A'), 'class');
    assert.equal(byName.get('f'), 'function');
    assert.equal(byName.get('I'), 'interface');
    assert.equal(byName.get('g'), 'variable');
  } finally { cleanup(); }
});

test('ASTParser: captures star and named re-export directives, but not local export/declarations', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const file = path.join(root, 'barrel.ts');
    fs.writeFileSync(file, [
      "export * from './origin';",
      "export { a, b as c } from './other';",
      'const local = 1;',
      'export { local };',
    ].join('\n'));
    const parsed = new ASTParser().parseFile(file);
    assert.deepEqual(parsed.reExports, [
      { specifier: './origin', imported: '*', exported: '*' },
      { specifier: './other', imported: 'a', exported: 'a' },
      { specifier: './other', imported: 'b', exported: 'c' },
    ]);
    // `export { local }` has no from-clause — not cross-file, and `local` is
    // already captured as its own variable symbol, so no extra symbol/re-export.
    assert.deepEqual(parsed.symbols.map(s => s.name), ['local']);
  } finally { cleanup(); }
});

test('ASTParser: Go, Rust, and Java declarations are indexed', () => {
  const { root, cleanup } = mkTempConfig();
  try {
    const parser = new ASTParser();
    const goFile = path.join(root, 'main.go');
    fs.writeFileSync(goFile, 'package main\ntype S struct{}\ntype I interface{}\nfunc Top() {}\nfunc (s S) Method() {}\n');
    assert.deepEqual(parser.parseFile(goFile).symbols.map(s => s.name).sort(), ['I', 'Method', 'S', 'Top']);

    const rustFile = path.join(root, 'lib.rs');
    fs.writeFileSync(rustFile, 'pub struct Thing;\npub trait Work {}\npub enum Choice { A }\ntype Alias = Thing;\npub fn run() {}\n');
    assert.deepEqual(parser.parseFile(rustFile).symbols.map(s => s.name).sort(), ['Alias', 'Choice', 'Thing', 'Work', 'run']);

    const javaFile = path.join(root, 'Demo.java');
    fs.writeFileSync(javaFile, 'class Demo { Demo() {} void run() {} } interface Api {} enum Mode { A }');
    assert.deepEqual(parser.parseFile(javaFile).symbols.map(s => s.name).sort(), ['Api', 'Demo', 'Demo', 'Mode', 'run']);
  } finally { cleanup(); }
});
