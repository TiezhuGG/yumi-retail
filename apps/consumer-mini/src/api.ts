import Taro from '@tarojs/taro';
declare const API_BASE_URL: string;
export interface SaleSku {
  id: string;
  productId: string;
  name: string;
  description: string;
  spec: string;
  unit: string;
  priceCents: number;
  available: number;
}
export interface ProductPage {
  items: SaleSku[];
  hasMore: boolean;
  nextCursor: string | null;
}
export async function request<T>(path: string): Promise<T> {
  const result = await Taro.request<{ data: T; error?: { message: string } }>({
    url: API_BASE_URL + path,
    method: 'GET',
    timeout: 10000,
  });
  if (result.statusCode !== 200)
    throw new Error(result.data.error?.message ?? '商品加载失败，请稍后重试');
  return result.data.data;
}
