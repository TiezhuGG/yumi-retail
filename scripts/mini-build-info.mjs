import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function consumerDevelopmentBuild(flag, target, apiBase, environment) {
  assert(
    flag === undefined || flag === '0' || flag === '1',
    'Invalid consumer development build flag',
  );
  if (flag !== '1') return false;
  const url = new URL(apiBase);
  assert(
    target === 'local' &&
      environment !== 'production' &&
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1',
    '开发身份仅允许显式本机开发构建，不能用于真机或生产。',
  );
  return true;
}

export function apiBaseForBuild(value, target) {
  assert(['local', 'device'].includes(target), 'Unknown mini build target');
  const invalid = '请配置不含账号、查询参数或片段的 API 地址，路径必须为 /api/v1。';
  if (target === 'device' && !value?.trim())
    throw Error(
      '真机编译需要 TARO_APP_API_BASE_URL；请先提供已配置为合法请求域名的 HTTPS 测试 API。',
    );
  let url;
  try {
    url = new URL(value?.trim() || 'http://127.0.0.1:3000/api/v1');
  } catch {
    throw Error(invalid);
  }
  assert(!url.username && !url.password && !url.search && !url.hash, invalid);
  assert(['http:', 'https:'].includes(url.protocol), invalid);
  assert(url.pathname.replace(/\/$/, '') === '/api/v1', invalid);
  if (target === 'device') {
    const host = url.hostname.toLowerCase();
    const validDns =
      host.length <= 253 &&
      host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
    const reserved =
      /(^|\.)(localhost|local|test|invalid|example)$/.test(host) ||
      /(^|\.)example\.(com|net|org)$/.test(host);
    assert(
      url.protocol === 'https:' &&
        !isIP(host.replace(/^\[|\]$/g, '')) &&
        validDns &&
        host.includes('.') &&
        !reserved,
      '真机编译需要真实 HTTPS 域名，不能使用 IP、回环地址、局域网名称或示例域名。',
    );
  }
  return url.href.replace(/\/$/, '');
}

function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink(), 'Mini output must not contain symlinks');
      return entry.isDirectory() ? inventory(root, name) : [name];
    })
    .sort();
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function collectBuildInfo(root, target, apiBase) {
  const normalized = apiBaseForBuild(apiBase, target);
  const names = inventory(root);
  assert(
    names.some(
      (file) => file.endsWith('.js') && readFileSync(join(root, file), 'utf8').includes(normalized),
    ),
    '编译产物中未找到本次 API 地址，请重新编译。',
  );
  return {
    formatVersion: 1,
    target,
    apiBase: normalized,
    builtAt: new Date().toISOString(),
    files: names.map((file) => ({
      path: file,
      bytes: statSync(join(root, file)).size,
      sha256: digest(join(root, file)),
    })),
    acceptance: {
      developerTool: 'not-recorded',
      realDevice: 'not-recorded',
      legalDomain: 'not-recorded',
    },
  };
}
export function verifyBuildInfo(root, info, target) {
  assert.equal(info.formatVersion, 1, 'Unknown build info format');
  assert.equal(info.target, target, `当前产物不是 ${target} 构建，请重新编译。`);
  const fresh = collectBuildInfo(root, target, info.apiBase);
  assert.deepEqual(info.files, fresh.files, '产物已变化或清单过期，请重新编译生成清单。');
  return info;
}
