import { useEffect, useState } from 'react';
export function CornMark() {
  return (
    <svg viewBox="0 0 48 56" fill="none" aria-hidden="true">
      <path d="M24 3c-9 0-14 12-14 24 0 10 5 17 14 17s14-7 14-17C38 15 33 3 24 3Z" fill="#FBC928" />
      <path
        d="M18 11v23m7-26v27m7-21v19M13 19h23M11 26h27M13 33h23"
        stroke="#FFE782"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M24 53C8 47 1 33 4 22c12 4 19 14 20 31Z" fill="#19A65B" />
      <path d="M24 53c17-5 23-18 21-32-13 5-20 16-21 32Z" fill="#087C41" />
      <path d="M24 52 10 30m14 22 15-23" stroke="#B6EAA0" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <CornMark />
      </span>
      <span>
        <strong>玉米百货</strong>
        <small>社区好生活</small>
      </span>
    </span>
  );
}
export function ProductArt({ name, imageSrc }: { name: string; imageSrc?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageSrc]);
  if (imageSrc && !failed)
    return (
      <img
        className="product-art-photo"
        src={imageSrc}
        alt={`${name}主图`}
        onError={() => setFailed(true)}
      />
    );
  const kind = /纸|巾/.test(name) ? 'paper' : /袋/.test(name) ? 'bag' : 'bottle';
  return (
    <span className={`product-art ${kind}`} aria-label="包装示意图">
      <span className="package">
        <i />
        <b>{kind === 'paper' ? '柔软日常' : kind === 'bag' ? '整洁生活' : '清新洗护'}</b>
        <em>YUMI / DAILY</em>
      </span>
    </span>
  );
}
