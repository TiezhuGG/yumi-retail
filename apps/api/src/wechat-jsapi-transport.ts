import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WechatCredentialStore } from './wechat-credentials.js';
import type { JsapiOrder, SignedJsapiRequest, MiniPaymentParameters } from './wechat-jsapi.js';

export class WechatTransportError extends Error {
  constructor(readonly code: 'REQUEST_INVALID' | 'RESULT_UNKNOWN') {
    super('WeChat HTTPS transport rejected: ' + code);
  }
}
export interface WechatRawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}
export type WechatHttpsRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
const endpoint = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
// Dependency injection is internal, for tests. No application config accepts an alternate host,
// proxy, CA, redirect, TLS bypass or client-controlled timeout/header/URL.
export function createWechatHttpsTransport(
  makeRequest: WechatHttpsRequest = httpsRequest,
  timeoutMs = 5000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new WechatTransportError('REQUEST_INVALID');
  return async (signed: SignedJsapiRequest): Promise<WechatRawResponse> => {
    if (
      signed.url !== endpoint ||
      signed.method !== 'POST' ||
      typeof signed.body !== 'string' ||
      Buffer.byteLength(signed.body) > 16384 ||
      !Object.isFrozen(signed) ||
      !Object.isFrozen(signed.headers) ||
      Object.keys(signed.headers).sort().join(',') !== 'Accept,Authorization,Content-Type' ||
      signed.headers.Accept !== 'application/json' ||
      signed.headers['Content-Type'] !== 'application/json' ||
      typeof signed.headers.Authorization !== 'string' ||
      !/^WECHATPAY2-SHA256-RSA2048 [\x20-\x7e]{1,2048}$/.test(signed.headers.Authorization)
    )
      throw new WechatTransportError('REQUEST_INVALID');
    return new Promise((resolve, reject) => {
      let settled = false,
        request: ClientRequest | undefined,
        response: IncomingMessage | undefined;
      const chunks: Buffer[] = [];
      let size = 0;
      const started = performance.now();
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request?.destroy();
        reject(new WechatTransportError('RESULT_UNKNOWN'));
      };
      // Total elapsed timeout includes DNS/TLS, headers and every response byte.
      const timer = setTimeout(fail, timeoutMs);
      try {
        request = makeRequest(
          {
            protocol: 'https:',
            hostname: 'api.mch.weixin.qq.com',
            port: 443,
            path: '/v3/pay/transactions/jsapi',
            method: 'POST',
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
            agent: false,
            maxHeaderSize: 16384,
            headers: {
              ...signed.headers,
              'Content-Length': String(Buffer.byteLength(signed.body)),
              'Accept-Encoding': 'identity',
            },
          },
          (incoming) => {
            response = incoming;
            if (settled) {
              incoming.destroy();
              return;
            }
            const headers: WechatRawResponse['headers'] = {};
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              const name = incoming.rawHeaders[i]!.toLowerCase(),
                value = incoming.rawHeaders[i + 1]!;
              if (name.startsWith('wechatpay-') && Object.hasOwn(headers, name)) {
                fail();
                return;
              }
              headers[name] = value;
            }
            // Never follow 3xx, decompress or reinterpret an upstream error as a failed payment.
            const length = headers['content-length'];
            if (
              !incoming.statusCode ||
              incoming.statusCode >= 300 ||
              incoming.statusCode < 200 ||
              (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
              (length !== undefined &&
                (typeof length !== 'string' || !/^\d{1,6}$/.test(length) || Number(length) > 65536))
            ) {
              fail();
              return;
            }
            incoming.on('error', fail);
            incoming.on('aborted', fail);
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > 65536 || performance.now() - started >= timeoutMs) {
                fail();
                return;
              }
              chunks.push(chunk);
            });
            incoming.on('end', () => {
              if (settled) return;
              if (
                !incoming.complete ||
                size < 1 ||
                (length !== undefined && Number(length) !== size) ||
                performance.now() - started >= timeoutMs
              ) {
                fail();
                return;
              }
              settled = true;
              clearTimeout(timer);
              resolve({
                status: incoming.statusCode!,
                headers,
                rawBody: Buffer.concat(chunks, size),
              });
            });
            incoming.on('close', () => {
              if (!incoming.complete) fail();
            });
          },
        );
        request.on('error', fail);
        request.end(signed.body, 'utf8');
      } catch {
        fail();
      }
    });
  };
}
export class WechatGatewayError extends Error {
  constructor(readonly code: 'NOT_DISPATCHED' | 'RESULT_UNKNOWN') {
    super('WeChat JSAPI gateway rejected: ' + code);
  }
}
// Internal building block, deliberately not registered in the running application.
// The caller must persist a payment attempt BEFORE invoking this, then store a verified
// result BEFORE returning parameters. C3b supplies that orchestration and cancellation gate.
export function createWechatJsapiGateway(
  credentials: WechatCredentialStore,
  send = createWechatHttpsTransport(),
  clock: () => number = Date.now,
) {
  return Object.freeze({
    async prepay(
      order: JsapiOrder,
    ): Promise<{ parameters: MiniPaymentParameters; credentialRevision: number }> {
      let snapshot, protocol, signed;
      const nowMs = clock(),
        started = performance.now();
      try {
        snapshot = credentials.current(nowMs);
        protocol = snapshot.protocol(nowMs);
        signed = protocol.prepay(order, Math.floor(nowMs / 1000));
      } catch {
        throw new WechatGatewayError('NOT_DISPATCHED');
      }
      try {
        const response = await send(signed);
        const finished = clock();
        if (
          !Number.isSafeInteger(finished) ||
          finished < nowMs ||
          Math.abs(finished - nowMs - (performance.now() - started)) > 30000
        )
          throw Error('CLOCK');
        snapshot.checkResponseKey(response.headers, finished);
        const parameters = protocol.invocation(signed, response, Math.floor(finished / 1000));
        return { parameters, credentialRevision: snapshot.revision };
      } catch {
        throw new WechatGatewayError('RESULT_UNKNOWN');
      }
    },
  });
}
