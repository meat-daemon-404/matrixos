import { IdtExchanger } from '../src/auth/idt.ts';
import { validateManifest } from '../src/manifest/validate.ts';

const probe = (l: string, v: unknown) => console.log(l, '=>', JSON.stringify(v));

// fake http client
function makeHttp(responder: (opts: any) => Promise<any>) {
  const calls: any[] = [];
  return {
    calls,
    request: async (opts: any) => {
      calls.push(opts);
      return responder(opts);
    },
  };
}

// --- success then second exchange
const okHttp = makeHttp(async () => ({ mx_at: 'tok', matrix_uid: 'mxu_1', expires_in: 900 }));
const ex = new IdtExchanger({ http: okHttp as any });
const first = await ex.exchange('idt-1');
probe('first exchange', first);
probe('request count after first', okHttp.calls.length);
try {
  await ex.exchange('idt-1');
  probe('second exchange', 'NO THROW (BAD)');
} catch (e: any) {
  probe('second exchange throws', { name: e.name, code: e.code, message: e.message.slice(0, 40) });
}
probe('request count after second', okHttp.calls.length);
probe('isConsumed', ex.isConsumed('idt-1'));

// --- concurrent
const slowHttp = makeHttp(async () => {
  await new Promise((r) => setTimeout(r, 20));
  return { mx_at: 'tok', matrix_uid: 'mxu_1' };
});
const ex2 = new IdtExchanger({ http: slowHttp as any });
const [a, b] = await Promise.all([ex2.exchange('idt-2'), ex2.exchange('idt-2')]);
probe('concurrent same object', a === b);
probe('concurrent request count', slowHttp.calls.length);

// --- server 409
const http409 = makeHttp(async () => {
  const { MatrixError } = await import('../src/errors.ts');
  throw new MatrixError({ code: 'CONFLICT', message: 'used', status: 409 });
});
const ex3 = new IdtExchanger({ http: http409 as any });
try { await ex3.exchange('idt-3'); } catch (e: any) { probe('409 code', e.code); }
probe('409 marks consumed', ex3.isConsumed('idt-3'));

// --- network error not consumed
const httpNet = makeHttp(async () => { throw new Error('boom'); });
const ex4 = new IdtExchanger({ http: httpNet as any });
try { await ex4.exchange('idt-4'); } catch (e: any) { probe('net error', e.message.slice(0, 30)); }
probe('net error marks consumed?', ex4.isConsumed('idt-4'));

// --- empty idt
try { await new IdtExchanger({ http: okHttp as any }).exchange('   '); } catch (e: any) { probe('blank idt', e.code); }

// --- TTL prune
let clock = 1000;
const httpTtl = makeHttp(async () => ({ mx_at: 't', matrix_uid: 'u' }));
const ex5 = new IdtExchanger({ http: httpTtl as any, now: () => clock, consumedTtlMs: 100 });
await ex5.exchange('idt-5');
probe('consumed before ttl', ex5.isConsumed('idt-5'));
clock = 2000;
probe('consumed after ttl', ex5.isConsumed('idt-5'));

// --- manifest semantics
const good = {
  manifest_version: '1.0', app_id: 'curvelab', name: 'x',
  entry_url: 'https://curvelab.matrixos.edu', orbit_station: 'study',
  accepts: ['curve_fit_parameters'], emits: ['curve_fit_parameters'],
  permissions: ['wormhole:send', 'wormhole:receive'],
};
const r1 = validateManifest(good);
probe('good valid', { valid: r1.valid, errs: r1.errors });
probe('http entry', validateManifest({ ...good, entry_url: 'http://curvelab.matrixos.edu' }).errors.map((e: any) => e.keyword));
probe('host mismatch', validateManifest({ ...good, entry_url: 'https://other.matrixos.edu' }).errors.map((e: any) => e.keyword));
probe('no perms', validateManifest({ ...good, permissions: [] }).errors.map((e: any) => e.keyword));
probe('dup accepts', validateManifest({ ...good, accepts: ['curve_fit_parameters', 'curve_fit_parameters'] }).errors.map((e: any) => e.keyword));
