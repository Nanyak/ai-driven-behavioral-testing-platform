export type Route =
  | { name: "home"; path: "/" }
  | { name: "product"; path: string; productId: string }
  | { name: "collection"; path: string; collectionName: string }
  | { name: "seller"; path: string; sellerName: string }
  | { name: "deals"; path: "/deals" }
  | { name: "signin"; path: "/signin" }
  | { name: "signup"; path: "/signup" }
  | { name: "profile"; path: "/profile" }
  | { name: "wishlist"; path: "/wishlist" }
  | { name: "orders"; path: "/orders" }
  | { name: "notifications"; path: "/notifications" }
  | { name: "order"; path: string; orderId: string }
  | { name: "cart"; path: "/cart" };

export function parseRoute(pathname: string): Route {
  const productMatch = pathname.match(/^\/products\/([^/]+)$/);
  const collectionMatch = pathname.match(/^\/collections\/([^/]+)$/);
  const sellerMatch = pathname.match(/^\/sellers\/([^/]+)$/);
  const orderMatch = pathname.match(/^\/orders\/([^/]+)$/);

  if (productMatch?.[1]) {
    const productId = decodeURIComponent(productMatch[1]);
    return { name: "product", path: `/products/${productId}`, productId };
  }

  if (collectionMatch?.[1]) {
    const collectionName = decodeURIComponent(collectionMatch[1]);
    return { name: "collection", path: `/collections/${collectionName}`, collectionName };
  }

  if (sellerMatch?.[1]) {
    const sellerName = decodeURIComponent(sellerMatch[1]);
    return { name: "seller", path: `/sellers/${sellerName}`, sellerName };
  }

  if (orderMatch?.[1]) {
    const orderId = decodeURIComponent(orderMatch[1]);
    return { name: "order", path: `/orders/${orderId}`, orderId };
  }

  if (pathname === "/signin") {
    return { name: "signin", path: "/signin" };
  }

  if (pathname === "/deals") {
    return { name: "deals", path: "/deals" };
  }

  if (pathname === "/signup") {
    return { name: "signup", path: "/signup" };
  }

  if (pathname === "/profile") {
    return { name: "profile", path: "/profile" };
  }

  if (pathname === "/wishlist") {
    return { name: "wishlist", path: "/wishlist" };
  }

  if (pathname === "/orders") {
    return { name: "orders", path: "/orders" };
  }

  if (pathname === "/notifications") {
    return { name: "notifications", path: "/notifications" };
  }

  if (pathname === "/cart") {
    return { name: "cart", path: "/cart" };
  }

  return { name: "home", path: "/" };
}

export function productPath(productId: string) {
  return `/products/${encodeURIComponent(productId)}`;
}

export function collectionPath(collectionName: string) {
  return `/collections/${encodeURIComponent(collectionName)}`;
}

export function sellerPath(sellerName: string) {
  return `/sellers/${encodeURIComponent(sellerName)}`;
}
