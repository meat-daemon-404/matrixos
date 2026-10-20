import { registerWormholeReceiver } from '../src/wormhole/index.ts';
import { OriginAllowList } from '../src/security/origin.ts';

const probe = (l: string, v: unknown) => console.log(l, '=>', JSON.stringify(v));

type Listener = (e: { data: unknown; origin: string }) => void;

function makeWindow() {
  const listeners: Listener[] = [];
  const posted: Array<{ msg: any; targetOrigin: string }> = [];
  const win: any = {
    location: { href: 'https://curvelab.matrixos.edu/x', origin: 'https://curvelab.matrixos.edu', host: 'curvelab.matrixos.edu', hostname: 'curvelab.matrixos.edu', protocol: 'https:', search: '' },
    parent: null,
    top: null,
    opener: null,
    postMessage: (msg: any, targetOrigin: string) => { posted.push({ msg, targetOrigin }); },
    addEventListener: (_t: string, l: Listener) => { listeners.push(l); },
    removeEventListener: (_t: string, l: Listener) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
    sessionStorage: null,
    localStorage: null,
    navigator: null,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  // self-referencing: opener is the "parent" that receives acks
  const parent: any = { ...win, postMessage: (msg: any, targetOrigin: string) => { posted.push({ msg, targetOrigin }); } };
  win.parent = parent;
  return { win, listeners, posted, parent };
}

const env: any = {
  hasDOM: true, win: null, doc: null, inIframe: true,
  origin: 'https://curvelab.matrixos.edu', href: '',
  fetchImpl: null, now: () => 0, randomUUID: () => 'uuid',
};

const envelope = {
  trace_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  matrix_uid: 'mxu_1',
  source_app: 'lit-sonar.matrixos.edu',
  target_app: 'curvelab.matrixos.edu',
  payload_type: 'curve_fit_parameters',
  payload: { data: { a: 1 }, evidence_anchors: [{ source_doi_or_url: '10.1/x', verification_level: 'Level_A_Verified' }] },
};

// --- trusted origin
{
  const { win, listeners, posted } = makeWindow();
  env.win = win;
  let drops = 0;
  const off = registerWormholeReceiver({
    env, selfApp: 'curvelab',
    allowedOrigins: new OriginAllowList(['*.matrixos.edu'], { allowLoopback: false }),
    options: { accepts: ['curve_fit_parameters'], onDrop: () => { drops += 1; } },
  });
  listeners[0]!({ data: { ch: 'matrixos/wormhole', v: 1, envelope, receiptId: 'r1' }, origin: 'https://lit-sonar.matrixos.edu' });
  probe('trusted: drops', drops);
  probe('trusted: acked', posted.length);
  probe('trusted: ack targetOrigin', posted[0]?.targetOrigin);
  await new Promise((r) => setTimeout(r, 0));
  off();
  probe('unsubscribe removes listener', listeners.length);
}

// --- untrusted origin
{
  const { win, listeners, posted } = makeWindow();
  env.win = win;
  let drops = 0;
  registerWormholeReceiver({
    env, selfApp: 'curvelab',
    allowedOrigins: new OriginAllowList(['*.matrixos.edu'], { allowLoopback: false }),
    options: { accepts: ['curve_fit_parameters'], onDrop: () => { drops += 1; } },
  });
  listeners[0]!({ data: { ch: 'matrixos/wormhole', v: 1, envelope }, origin: 'https://evil.com' });
  probe('untrusted: drops', drops);
  probe('untrusted: ack/reply count (must be 0)', posted.length);
}

// --- empty evidence anchors over wire
{
  const { win, listeners } = makeWindow();
  env.win = win;
  let drops = 0;
  registerWormholeReceiver({
    env, selfApp: 'curvelab',
    allowedOrigins: new OriginAllowList(['*.matrixos.edu'], { allowLoopback: false }),
    options: { accepts: ['curve_fit_parameters'], onDrop: () => { drops += 1; } },
  });
  const bad = { ...envelope, payload: { data: { a: 1 }, evidence_anchors: [] } };
  listeners[0]!({ data: { ch: 'matrixos/wormhole', v: 1, envelope: bad }, origin: 'https://a.matrixos.edu' });
  probe('empty anchors: drops', drops);
}

// --- accepts mismatch
{
  const { win, listeners } = makeWindow();
  env.win = win;
  let drops = 0;
  registerWormholeReceiver({
    env, selfApp: 'curvelab',
    allowedOrigins: new OriginAllowList(['*.matrixos.edu'], { allowLoopback: false }),
    options: { accepts: ['paper_doi_bundle'], onDrop: () => { drops += 1; } },
  });
  listeners[0]!({ data: { ch: 'matrixos/wormhole', v: 1, envelope }, origin: 'https://a.matrixos.edu' });
  probe('accepts mismatch: drops', drops);
}

// --- wrong target app
{
  const { win, listeners } = makeWindow();
  env.win = win;
  let drops = 0;
  registerWormholeReceiver({
    env, selfApp: 'someoneelse',
    allowedOrigins: new OriginAllowList(['*.matrixos.edu'], { allowLoopback: false }),
    options: { accepts: ['curve_fit_parameters'], onDrop: () => { drops += 1; } },
  });
  listeners[0]!({ data: { ch: 'matrixos/wormhole', v: 1, envelope }, origin: 'https://a.matrixos.edu' });
  probe('wrong target: drops', drops);
}
