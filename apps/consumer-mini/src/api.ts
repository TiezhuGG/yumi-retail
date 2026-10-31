import Taro from '@tarojs/taro';
declare const API_BASE_URL: string;
export interface SaleSku {
  imageUrl?: string | null;
  imageUrls?: string[];
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

export const productImageUrl = (path: string) => API_BASE_URL.replace(/\/api\/v1\/?$/, '') + path;

export interface SaleSkuDetail extends SaleSku {
  variants: SaleSku[];
}

export interface PublicCategory {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
}
export interface PublicCategoryPage {
  items: PublicCategory[];
  hasMore: boolean;
  nextCursor: string | null;
}
