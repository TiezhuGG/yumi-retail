import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { constants, createPrivateKey, sign, verify } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wechatCredentialsFixture } from './helpers/wechat-credentials-fixture.ts';
import {
  createWechatHttpsTransport,
  createWechatJsapiGateway,
  WechatGatewayError,
  WechatTransportError,
  type WechatHttpsRequest,
} from '../apps/api/src/wechat-jsapi-transport.ts';
import type { JsapiOrder } from '../apps/api/src/wechat-jsapi.ts';
type F = Awaited<ReturnType<typeof wechatCredentialsFixture>>;
function order(f: F): JsapiOrder {
  return {
    outTradeNo: 'Y20261106000000000ABCDEF123456',
    totalCents: 2499,
    description: '合成纸巾与日用品',
    paymentDeadline: new Date(f.now + 900000),
    payer: {
      provider: 'WECHAT',
      appId: f.binding.appId,
      openId: 'synthetic-openid-transport-0001',
    },
  };
}
function signedResponse(
  f: F,
  raw = Buffer.from('{"prepay_id":"wx_synthetic_prepay"}'),
  seconds = Math.floor(f.now / 1000),
) {
  const nonce = 'synthetic_nonce';
  return {
    raw,
    headers: {
      'Wechatpay-Serial': f.manifest.platformKeys[0]!.id,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Timestamp': String(seconds),
      'Wechatpay-Signature': sign(
        'RSA-SHA256',
        Buffer.concat([Buffer.from(seconds + '\n' + nonce + '\n'), raw, Buffer.from('\n')]),
        { key: f.platform.privateKey, padding: constants.RSA_PKCS1_PADDING },
      ).toString('base64'),
    },
  };
}
async function server(f: F, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  let count = 0;
  const instance = createServer({ key: f.privatePem, cert: f.certificatePem }, (r, s) => {
    count++;
    handler(r, s);
  });
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolve);
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  const transport = (timeoutMs = 1000, trusted = true) => {
    const factory: WechatHttpsRequest = (options, callback) => {
      assert.equal(options.hostname, 'api.mch.weixin.qq.com');
      assert.equal(options.port, 443);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.minVersion, 'TLSv1.2');
      assert.equal(options.path, '/v3/pay/transactions/jsapi');
      assert.equal(options.agent, false);
      // Only the test dependency connects to loopback; normal transport has no host override.
      return httpsRequest(
        {
          ...options,
          hostname: '127.0.0.1',
          port: address.port,
          servername: 'api.mch.weixin.qq.com',
          ...(trusted ? { ca: f.certificatePem } : {}),
        },
        callback,
      );
    };
    return createWechatHttpsTransport(factory, timeoutMs);
  };
  return {
    transport,
    count: () => count,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
const unknown = (e: unknown) => e instanceof WechatGatewayError && e.code === 'RESULT_UNKNOWN';
test('real loopback TLS preserves the signed UTF-8 request and verifies raw response before returning five invocation fields', async () => {
  const f = await wechatCredentialsFixture();
  let body = '',
    authorization = '';
  const expected = signedResponse(f);
  const s = await server(f, (r, response) => {
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v3/pay/transactions/jsapi');
    assert.equal(r.headers['accept-encoding'], 'identity');
    authorization = r.headers.authorization!;
    r.setEncoding('utf8');
    r.on('data', (chunk) => {
      body += chunk;
    });
    r.on('end', () => {
      assert.equal(Number(r.headers['content-length']), Buffer.byteLength(body));
      response.writeHead(200, expected.headers);
      response.end(expected.raw);
    });
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const value = await createWechatJsapiGateway(store, s.transport(), () => f.now).prepay(
      order(f),
    );
    assert.equal(value.credentialRevision, 1);
    assert.deepEqual(Object.keys(value.parameters).sort(), [
      'nonceStr',
      'package',
      'paySign',
      'signType',
      'timeStamp',
    ]);
    assert.equal(value.parameters.package, 'prepay_id=wx_synthetic_prepay');
    const fields = Object.fromEntries(
      [...authorization.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(
          `POST\n/v3/pay/transactions/jsapi\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`,
        ),
        createPrivateKey(f.privatePem),
        Buffer.from(fields.signature!, 'base64'),
      ),
      true,
    );
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(
          `${f.binding.appId}\n${value.parameters.timeStamp}\n${value.parameters.nonceStr}\n${value.parameters.package}\n`,
        ),
        createPrivateKey(f.privatePem),
        Buffer.from(value.parameters.paySign, 'base64'),
      ),
      true,
    );
    assert.equal(JSON.parse(body).payer.openid, order(f).payer.openId);
    assert.equal(s.count(), 1);
    assert.ok(!JSON.stringify(value).includes(order(f).payer.openId));
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('redirects and every HTTP error are unknown results, never retried or followed', async () => {
  const f = await wechatCredentialsFixture();
  let status = 302;
  const s = await server(f, (_r, response) => {
    response.writeHead(status, { Location: 'https://untrusted.invalid/do-not-follow' });
    response.end('synthetic-secret-upstream');
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const gateway = createWechatJsapiGateway(store, s.transport(), () => f.now);
    for (const code of [302, 400, 401, 429, 500, 503]) {
      status = code;
      await assert.rejects(gateway.prepay(order(f)), (e) => {
        assert.ok(unknown(e));
        assert.ok(!(e as Error).message.includes('synthetic-secret'));
        return true;
      });
    }
    assert.equal(s.count(), 6);
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('duplicate signature headers, compression, declared or streamed oversized bodies and empty responses fail', async () => {
  const f = await wechatCredentialsFixture(),
    value = signedResponse(f);
  let mode = 0;
  const s = await server(f, (_r, response) => {
    if (mode === 0) {
      response.writeHead(200, { ...value.headers, 'Wechatpay-Nonce': ['one', 'two'] });
      response.end(value.raw);
    } else if (mode === 1) {
      response.writeHead(200, { ...value.headers, 'Content-Encoding': 'gzip' });
      response.end(value.raw);
    } else if (mode === 2) {
      response.writeHead(200, { ...value.headers, 'Content-Length': '65537' });
      response.end('x');
    } else if (mode === 3) {
      response.writeHead(200, value.headers);
      response.write(Buffer.alloc(32768));
      response.end(Buffer.alloc(32769));
    } else {
      response.writeHead(200, value.headers);
      response.end();
    }
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const gateway = createWechatJsapiGateway(store, s.transport(), () => f.now);
    for (mode = 0; mode < 5; mode++) await assert.rejects(gateway.prepay(order(f)), unknown);
    assert.equal(s.count(), 5);
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('total timeout covers waiting for headers and a dripping body; truncated connections remain unknown', async () => {
  const f = await wechatCredentialsFixture(),
    value = signedResponse(f);
  let mode = 0;
  const s = await server(f, (_r, response) => {
    if (mode === 0) return; // No headers, bounded by total timeout.
    if (mode === 1) {
      response.writeHead(200, value.headers);
      response.write('a');
      const timer = setInterval(() => {
        if (!response.destroyed) response.write('a');
      }, 20);
      response.once('close', () => clearInterval(timer));
      return;
    }
    if (mode === 2) {
      response.writeHead(200, {
        ...value.headers,
        'Content-Length': String(value.raw.length + 10),
      });
      response.end(value.raw);
      return;
    }
    response.destroy();
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const gateway = createWechatJsapiGateway(store, s.transport(150), () => f.now);
    for (mode = 0; mode < 4; mode++) {
      const start = performance.now();
      await assert.rejects(gateway.prepay(order(f)), unknown);
      assert.ok(performance.now() - start < 1500);
    }
    assert.equal(s.count(), 4);
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('TLS trust is required and malformed requests cannot reach any transport endpoint', async () => {
  const f = await wechatCredentialsFixture();
  const s = await server(f, (_r, response) => response.end('not reached'));
  try {
    const store = f.store();
    await store.reload(f.now);
    await assert.rejects(
      createWechatJsapiGateway(store, s.transport(1000, false), () => f.now).prepay(order(f)),
      unknown,
    );
    assert.equal(s.count(), 0);
    const signed = store
      .current(f.now)
      .protocol(f.now)
      .prepay(order(f), Math.floor(f.now / 1000));
    const invalids = [
      { ...signed, url: 'http://api.mch.weixin.qq.com/v3/pay/transactions/jsapi' },
      { ...signed, url: 'https://untrusted.invalid/' },
      { ...signed, headers: Object.freeze({ ...signed.headers, Host: 'untrusted.invalid' }) },
      { ...signed, body: 'x'.repeat(16385) },
    ];
    for (const invalid of invalids)
      await assert.rejects(
        s.transport()(Object.freeze(invalid)),
        (e) => e instanceof WechatTransportError && e.code === 'REQUEST_INVALID',
      );
    assert.equal(s.count(), 0);
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('valid TLS does not replace signature verification; tampering or unknown/expired public keys stay unknown', async () => {
  const f = await wechatCredentialsFixture(),
    value = signedResponse(f);
  let mode = 0;
  const s = await server(f, (_r, response) => {
    response.writeHead(
      200,
      mode === 1 ? { ...value.headers, 'Wechatpay-Serial': 'PUB_KEY_ID_UNKNOWN' } : value.headers,
    );
    response.end(mode === 0 ? '{"prepay_id":"tampered"}' : value.raw);
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const gateway = createWechatJsapiGateway(store, s.transport(), () => f.now);
    for (mode = 0; mode < 2; mode++) await assert.rejects(gateway.prepay(order(f)), unknown);
    mode = 2;
    f.manifest.revision = 2;
    f.manifest.platformKeys[0]!.notAfter = new Date(f.now + 1000).toISOString();
    await f.save();
    await store.reload(f.now);
    let calls = 0;
    await assert.rejects(
      createWechatJsapiGateway(store, s.transport(), () => f.now + (calls++ ? 2000 : 0)).prepay(
        order(f),
      ),
      unknown,
    );
  } finally {
    await s.close();
    await f.cleanup();
  }
});
test('rotating keys during a request preserves its original verification and invocation signing context', async () => {
  const f = await wechatCredentialsFixture(),
    next = await wechatCredentialsFixture();
  const oldResponse = signedResponse(f),
    newResponse = signedResponse(next);
  let entered = () => {},
    release = () => {};
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let mode = 0;
  const s = await server(f, (_r, response) => {
    const value = mode ? newResponse : oldResponse;
    entered();
    void gate.then(() => {
      response.writeHead(200, value.headers);
      response.end(value.raw);
    });
  });
  try {
    const store = f.store();
    await store.reload(f.now);
    const gateway = createWechatJsapiGateway(store, s.transport(), () => f.now);
    const pending = gateway.prepay(order(f));
    await reached;
    await writeFile(join(f.directory, 'merchant.pem'), next.privatePem);
    await writeFile(join(f.directory, 'certificate.pem'), next.certificatePem);
    await writeFile(
      join(f.directory, 'platform.pem'),
      next.platform.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    f.manifest.revision = 2;
    await f.save();
    await store.reload(next.now);
    release();
    const a = await pending;
    assert.equal(a.credentialRevision, 1);
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(
          `${f.binding.appId}\n${a.parameters.timeStamp}\n${a.parameters.nonceStr}\n${a.parameters.package}\n`,
        ),
        createPrivateKey(f.privatePem),
        Buffer.from(a.parameters.paySign, 'base64'),
      ),
      true,
    );
    mode = 1;
    const b = await createWechatJsapiGateway(store, s.transport(), () => next.now).prepay(
      order(next),
    );
    assert.equal(b.credentialRevision, 2);
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(
          `${next.binding.appId}\n${b.parameters.timeStamp}\n${b.parameters.nonceStr}\n${b.parameters.package}\n`,
        ),
        createPrivateKey(next.privatePem),
        Buffer.from(b.parameters.paySign, 'base64'),
      ),
      true,
    );
  } finally {
    release();
    await s.close();
    await f.cleanup();
    await next.cleanup();
  }
});
test('unloaded credentials and invalid order are rejected before any dispatch', async () => {
  const f = await wechatCredentialsFixture();
  try {
    let calls = 0;
    const store = f.store(),
      send = async () => {
        calls++;
        throw Error('synthetic-not-called');
      };
    const gateway = createWechatJsapiGateway(store, send, () => f.now);
    await assert.rejects(
      gateway.prepay(order(f)),
      (e) => e instanceof WechatGatewayError && e.code === 'NOT_DISPATCHED',
    );
    await store.reload(f.now);
    await assert.rejects(
      gateway.prepay({ ...order(f), totalCents: 0 }),
      (e) => e instanceof WechatGatewayError && e.code === 'NOT_DISPATCHED',
    );
    assert.equal(calls, 0);
  } finally {
    await f.cleanup();
  }
});
