import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppKey } from '../src/security/origin.ts';
test('smoke', () => { assert.equal(normalizeAppKey('CurveLab.matrixos.edu'), 'curvelab'); });

