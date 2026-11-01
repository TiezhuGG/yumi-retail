/** In-memory navigation only. The target API remains authoritative for scope and ownership. */
export interface PaymentReviewTarget {
  warehouseId: string;
  attemptId: string;
  focus?: string;
}
export interface PaymentReviewDestination extends PaymentReviewTarget {
  token: number;
}
export type OpenPaymentReview = (target: PaymentReviewTarget, origin: HTMLButtonElement) => void;
