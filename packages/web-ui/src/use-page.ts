import { useEffect, useRef, useState } from 'react';
import type { Page } from '@yumi/contracts';
import { staffRequest } from './index.js';

// Each response belongs to one URL and request; stale pages cannot replace a newer filter.
export function usePage<T>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const current = useRef(url);
  current.current = url;
  async function read(after?: string) {
    if (!url) return;
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const page = await staffRequest<Page<T>>(
        `${url}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
      );
      if (token !== sequence.current || url !== current.current) return;
      setItems((old) => (after ? [...old, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (token === sequence.current && url === current.current)
        setError(e instanceof Error ? e.message : '资料加载失败');
      throw e;
    } finally {
      if (token === sequence.current && url === current.current) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setError('');
    setLoading(!!url);
    void read().catch(() => {});
    return () => {
      sequence.current++;
    };
  }, [url]);
  return {
    items,
    cursor,
    loading,
    error,
    reload: () => read(),
    next: () => (cursor ? read(cursor) : Promise.resolve()),
  };
}
