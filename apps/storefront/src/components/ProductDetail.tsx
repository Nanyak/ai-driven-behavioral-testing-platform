import { useMemo, useState, type FormEvent } from "react";
import { BadgeCheck, CreditCard, Heart, Package, Plus, RotateCcw, ShieldCheck, Star, Truck } from "lucide-react";
import { AppLink } from "./AppLink";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Label } from "./ui/label";
import type { Customer, Product, ProductReview, Variant } from "../types/storefront";
import { formatMoney, getVariantPrice } from "../utils/money";

type ProductDetailProps = {
  product?: Product;
  selectedVariant?: Variant;
  selectedVariantId: string;
  isBusy: boolean;
  isWishlisted: boolean;
  customer: Customer | null;
  hasPurchased: boolean;
  reviews: ProductReview[];
  onSelectVariant: (variantId: string) => void;
  onAddToCart: () => void;
  onSubmitReview: (review: Omit<ProductReview, "id" | "created_at" | "product_id">) => void;
  onToggleWishlist: () => void;
  onNavigate: (path: string) => void;
};

export function ProductDetail({
  product,
  selectedVariant,
  selectedVariantId,
  isBusy,
  isWishlisted,
  customer,
  hasPurchased,
  reviews,
  onSelectVariant,
  onAddToCart,
  onSubmitReview,
  onToggleWishlist,
  onNavigate,
}: ProductDetailProps) {
  const [reviewAuthor, setReviewAuthor] = useState("");
  const [reviewRating, setReviewRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [activeImageUrl, setActiveImageUrl] = useState("");
  const selectedPrice = getVariantPrice(selectedVariant);
  const inventoryQuantity = selectedVariant?.inventory_quantity;
  const tracksInventory = selectedVariant?.manage_inventory !== false;
  const isOutOfStock = tracksInventory && (inventoryQuantity ?? 0) <= 0;
  const averageRating = useMemo(() => {
    if (reviews.length === 0) {
      return 0;
    }

    return reviews.reduce((total, review) => total + review.rating, 0) / reviews.length;
  }, [reviews]);
  const productImages = useMemo(() => {
    const urls = [product?.thumbnail, ...(product?.images ?? []).map((image) => image.url)]
      .filter((url): url is string => Boolean(url));
    return Array.from(new Set(urls));
  }, [product]);
  const displayedImageUrl = activeImageUrl || productImages[0];

  function handleReviewSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitReview({
      author: reviewAuthor || "Verified buyer",
      rating: reviewRating,
      title: reviewTitle,
      body: reviewBody,
    });
    setReviewAuthor("");
    setReviewRating(5);
    setReviewTitle("");
    setReviewBody("");
  }

  if (!product) {
    return (
      <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5" aria-label="Product detail">
        <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-emerald-700">
          <Package className="size-12" aria-hidden="true" />
          <p className="font-bold">Select a product to see details.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="grid overflow-hidden rounded-lg border border-emerald-100 bg-white shadow-xl shadow-emerald-950/5 lg:grid-cols-[minmax(260px,44%)_minmax(0,1fr)]" aria-label={`${product.title} details`}>
      <div className="grid gap-3 bg-gradient-to-br from-emerald-100 to-orange-100 p-4 text-emerald-600 lg:min-h-[540px]">
        <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-lg bg-white/40">
          {displayedImageUrl ? <img className="h-full w-full object-cover" src={displayedImageUrl} alt={product.title} /> : <Package className="size-16" aria-hidden="true" />}
        </div>
        {productImages.length > 1 ? (
          <div className="grid grid-cols-5 gap-2">
            {productImages.slice(0, 5).map((imageUrl) => (
              <button
                key={imageUrl}
                type="button"
                className={`aspect-square overflow-hidden rounded-lg border bg-white ${displayedImageUrl === imageUrl ? "border-orange-500 ring-2 ring-orange-400/40" : "border-white/70"}`}
                onClick={() => setActiveImageUrl(imageUrl)}
                aria-label={`View ${product.title} image`}
              >
                <img className="h-full w-full object-cover" src={imageUrl} alt="" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col justify-center gap-5 p-6 lg:p-9">
        <p className="text-xs font-black uppercase tracking-normal text-emerald-700">{product.handle || "Seeded product"}</p>
        <h2 className="text-4xl font-black leading-none tracking-tight text-emerald-950 lg:text-6xl">{product.title}</h2>
        <p className="max-w-prose text-base font-semibold leading-8 text-emerald-900/75">
          {product.description || product.subtitle || "Ready for cart and checkout testing."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 font-black text-amber-800">
            <Star className="size-4 fill-current" aria-hidden="true" />
            {averageRating ? averageRating.toFixed(1) : "New"}
          </span>
          <span className="font-bold text-emerald-700">{reviews.length} reviews</span>
        </div>
        <div className="grid gap-2">
          <Label className="font-black text-emerald-950">
            Variant
            {selectedVariant && (
              <span className="ml-2 font-semibold text-emerald-600">— {selectedVariant.title}</span>
            )}
          </Label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Select variant">
            {(product.variants ?? []).map((variant) => {
              const isSelected = selectedVariantId === variant.id || (!selectedVariantId && product.variants?.[0]?.id === variant.id);
              const variantPrice = getVariantPrice(variant);
              return (
                <button
                  key={variant.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectVariant(variant.id)}
                  className={`rounded-xl border px-4 py-2 text-sm font-bold transition-all duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/25 ${
                    isSelected
                      ? "border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-700/20"
                      : "border-emerald-200 bg-white text-emerald-900 hover:border-emerald-400 hover:bg-emerald-50"
                  }`}
                >
                  {variant.title}
                  {variantPrice && (
                    <span className={`ml-1.5 text-xs ${isSelected ? "text-emerald-100" : "text-emerald-600"}`}>
                      {formatMoney(variantPrice.amount, variantPrice.currency)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid gap-1">
            <strong className="text-3xl font-black text-emerald-950">{formatMoney(selectedPrice?.amount, selectedPrice?.currency)}</strong>
            <span className="text-sm font-black text-emerald-700">
              {tracksInventory ? `${inventoryQuantity ?? 0} remaining` : "In stock"}
            </span>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className={`h-11 border-emerald-200 px-4 font-black hover:bg-emerald-50 ${isWishlisted ? "bg-red-50 text-red-600" : "text-emerald-800"}`} onClick={onToggleWishlist}>
              <Heart className={`size-4 ${isWishlisted ? "fill-current" : ""}`} aria-hidden="true" />
              <span>{isWishlisted ? "Saved" : "Save"}</span>
            </Button>
            <Button
              type="button"
              className="h-11 bg-orange-500 px-5 font-black text-white hover:bg-orange-600"
              onClick={customer ? onAddToCart : () => onNavigate("/signin")}
              disabled={isBusy || !selectedVariant || isOutOfStock}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span>{!customer ? "Sign in to buy" : isOutOfStock ? "Out of stock" : "Add to cart"}</span>
            </Button>
          </div>
        </div>
        <div className="grid gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 p-4 sm:grid-cols-2">
          {[
            ["Buyer protection", "Refund support after checkout", ShieldCheck],
            ["Fast delivery", "Shipping options at checkout", Truck],
            ["Secure payment", "Provider session via Medusa", CreditCard],
            ["Easy returns", "Request return from order page", RotateCcw],
          ].map(([title, text, Icon]) => (
            <div key={title as string} className="flex gap-2">
              <Icon className="mt-1 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
              <div>
                <strong className="block text-sm text-emerald-950">{title as string}</strong>
                <span className="text-xs font-bold text-emerald-700">{text as string}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reviews section */}
      <div className="grid gap-5 border-t border-emerald-100 p-6 lg:col-span-2 lg:p-9">
        <div>
          <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Reviews</p>
          <h3 className="mt-1 text-2xl font-black text-emerald-950">Shopper feedback</h3>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Review list */}
          <div className="grid content-start gap-3">
            {reviews.length > 0 ? reviews.map((review) => (
              <article key={review.id} className="grid gap-2 rounded-lg border border-emerald-100 bg-emerald-50/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-emerald-950">{review.title}</strong>
                  <span className="flex items-center gap-1 font-black text-amber-700">
                    <Star className="size-4 fill-current" aria-hidden="true" />
                    {review.rating}/5
                  </span>
                </div>
                <p className="font-semibold leading-6 text-emerald-900/75">{review.body}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-emerald-700">{review.author}</span>
                  <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-black text-emerald-700">
                    <BadgeCheck className="size-3" aria-hidden="true" />
                    Verified Buyer
                  </span>
                </div>
              </article>
            )) : (
              <p className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-4 font-bold text-emerald-700">
                No reviews yet. Be the first to review after receiving your order.
              </p>
            )}
          </div>

          {/* Review form — gated by login + purchase */}
          {!customer ? (
            <div className="grid content-start gap-3 rounded-lg border border-emerald-100 bg-white p-6 text-center">
              <Star className="mx-auto size-10 text-amber-400" aria-hidden="true" />
              <h4 className="font-black text-emerald-950">Share your experience</h4>
              <p className="text-sm font-semibold leading-6 text-emerald-900/70">
                Sign in to leave a review after receiving your order.
              </p>
              <AppLink
                className="inline-flex h-10 items-center justify-center rounded-lg bg-emerald-700 px-5 font-black text-white hover:bg-emerald-800"
                to="/signin"
                onNavigate={onNavigate}
              >
                Sign in
              </AppLink>
            </div>
          ) : !hasPurchased ? (
            <div className="grid content-start gap-3 rounded-lg border border-dashed border-emerald-200 bg-emerald-50/50 p-6 text-center">
              <Package className="mx-auto size-10 text-emerald-400" aria-hidden="true" />
              <h4 className="font-black text-emerald-950">Review after receiving</h4>
              <p className="text-sm font-semibold leading-6 text-emerald-900/70">
                You can review this item after receiving it. Complete your order first.
              </p>
              <AppLink
                className="inline-flex h-10 items-center justify-center rounded-lg bg-orange-500 px-5 font-black text-white hover:bg-orange-600"
                to="/"
                onNavigate={onNavigate}
              >
                Continue shopping
              </AppLink>
            </div>
          ) : (
            <form className="grid content-start gap-3 rounded-lg border border-emerald-100 bg-white p-4" onSubmit={handleReviewSubmit}>
              <h4 className="font-black text-emerald-950">Write a review</h4>
              <div className="grid gap-2">
                <Label htmlFor="review-author" className="font-black text-emerald-950">Name</Label>
                <input id="review-author" className="h-10 rounded-lg border border-emerald-200 px-3 font-bold outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15" value={reviewAuthor} onChange={(event) => setReviewAuthor(event.target.value)} placeholder="Verified buyer" />
              </div>
              <div className="grid gap-2">
                <Label className="font-black text-emerald-950">Rating</Label>
                <div className="flex gap-1" role="group" aria-label="Select rating">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      className="p-0.5 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                      onClick={() => setReviewRating(star)}
                      onMouseEnter={() => setHoverRating(star)}
                      onMouseLeave={() => setHoverRating(0)}
                      aria-label={`Rate ${star} out of 5`}
                    >
                      <Star
                        className={`size-7 transition-colors ${star <= (hoverRating || reviewRating) ? "fill-amber-400 text-amber-400" : "text-slate-200"}`}
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="review-title" className="font-black text-emerald-950">Title</Label>
                <input id="review-title" className="h-10 rounded-lg border border-emerald-200 px-3 font-bold outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15" value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="review-body" className="font-black text-emerald-950">Review</Label>
                <textarea id="review-body" className="min-h-24 rounded-lg border border-emerald-200 px-3 py-2 font-bold outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15" value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} required />
              </div>
              <Button type="submit" className="h-10 bg-emerald-700 font-black text-white hover:bg-emerald-800">
                Submit review
              </Button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
