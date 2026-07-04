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
