import { OriginAllowList, parseOrigin } from '../src/security/origin.ts';
import { validateAgainstSchema } from '../src/contracts/validate.ts';
import { WORMHOLE_ENVELOPE_SCHEMA, MATRIX_APP_MANIFEST_SCHEMA } from '../src/contracts/schemas.ts';

const probe = (label: string, value: unknown) => console.log(label, '=>', JSON.stringify(value));

// ---- origins
const list = new OriginAllowList(['*.matrixos.edu', 'matrixos.edu', 'https://orbital.matrixos.edu'], { allowLoopback: false });
for (const o of [
  'https://curvelab.matrixos.edu',
  'https://a.b.matrixos.edu',
  'https://matrixos.edu',
  'https://evil-matrixos.edu',
  'https://evil.com',
  'http://curvelab.matrixos.edu',
  'https://orbital.matrixos.edu',
  'https://orbital.matrixos.edu:443',
  'https://orbital.matrixos.edu:8443',
  'http://localhost:3000',
  'https://MATRIXOS.EDU',
  '',
  'null',
  'file:///etc/passwd',
]) {
  probe(`allows(${JSON.stringify(o)})`, list.allows(o));
}
probe('parseOrigin("null")', parseOrigin('null'));
probe('empty list isEmpty', new OriginAllowList([], { allowLoopback: false }).isEmpty);
probe('allows(evil) on empty list', new OriginAllowList([], { allowLoopback: false }).allows('https://evil.com'));

// ---- wormhole trace_id boundaries
const base = {
  trace_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  matrix_uid: 'mxu_1',
  source_app: 'curvelab.matrixos.edu',
  target_app: 'mentor.matrixos.edu',
  payload_type: 'curve_fit_parameters',
  payload: { data: {}, evidence_anchors: [{ source_doi_or_url: '10.1/x', verification_level: 'Level_A_Verified' }] },
};
const v = (env: unknown) => validateAgainstSchema(env, WORMHOLE_ENVELOPE_SCHEMA).map((i) => `${i.path}:${i.keyword}`);

probe('baseline envelope', v(base));
probe('empty evidence_anchors', v({ ...base, payload: { data: {}, evidence_anchors: [] } }));
probe('trace_id not uuid', v({ ...base, trace_id: 'abc' }));
probe('trace_id trailing newline', v({ ...base, trace_id: base.trace_id + '\n' }));
probe('trace_id 10KB uuid-ish', v({ ...base, trace_id: base.trace_id.repeat(100) }));
probe('empty payload data', v({ ...base, payload: { data: {}, evidence_anchors: base.payload.evidence_anchors } }));
probe('data as array', v({ ...base, payload: { data: [], evidence_anchors: base.payload.evidence_anchors } }));
probe('data null', v({ ...base, payload: { data: null, evidence_anchors: base.payload.evidence_anchors } }));
probe('extra envelope key', v({ ...base, evil: 1 }));
probe('bbox 3 items', v({ ...base, payload: { data: {}, evidence_anchors: [{ source_doi_or_url: 'a', verification_level: 'Level_A_Verified', bbox: [1, 2, 3] }] } }));
probe('pdf_page 0', v({ ...base, payload: { data: {}, evidence_anchors: [{ source_doi_or_url: 'a', verification_level: 'Level_A_Verified', pdf_page: 0 }] } }));
probe('bad verification_level', v({ ...base, payload: { data: {}, evidence_anchors: [{ source_doi_or_url: 'a', verification_level: 'Level_Z' }] } }));

// ---- manifest
const manifest = {
  manifest_version: '1.0',
  app_id: 'curvelab',
  name: '曲线实验室',
  entry_url: 'https://curvelab.matrixos.edu',
  orbit_station: 'study',
  accepts: ['curve_fit_parameters'],
  emits: ['curve_fit_parameters'],
  permissions: ['wormhole:send', 'wormhole:receive'],
};
const mv = (m: unknown) => validateAgainstSchema(m, MATRIX_APP_MANIFEST_SCHEMA).map((i) => `${i.path}:${i.keyword}`);
probe('baseline manifest', mv(manifest));
const { name, ...withoutName } = manifest as Record<string, unknown>;
probe('manifest missing name', mv(withoutName));
probe('app_id too short', mv({ ...manifest, app_id: 'ab' }));
probe('app_id uppercase', mv({ ...manifest, app_id: 'CurveLab' }));
probe('extra key', mv({ ...manifest, foo: 1 }));
probe('bad orbit_station', mv({ ...manifest, orbit_station: 'nope' }));
probe('entry_url http', mv({ ...manifest, entry_url: 'http://curvelab.matrixos.edu' }));
