export type Route =
  | { name: "home"; path: "/" }
  | { name: "product"; path: string; productId: string }
  | { name: "signin"; path: "/signin" }
  | { name: "signup"; path: "/signup" }
  | { name: "profile"; path: "/profile" }
  | { name: "cart"; path: "/cart" };

export function parseRoute(pathname: string): Route {
  const productMatch = pathname.match(/^\/products\/([^/]+)$/);

  if (productMatch?.[1]) {
    const productId = decodeURIComponent(productMatch[1]);
    return { name: "product", path: `/products/${productId}`, productId };
  }

  if (pathname === "/signin") {
    return { name: "signin", path: "/signin" };
  }

  if (pathname === "/signup") {
    return { name: "signup", path: "/signup" };
  }

  if (pathname === "/profile") {
    return { name: "profile", path: "/profile" };
  }

  if (pathname === "/cart") {
    return { name: "cart", path: "/cart" };
  }

  return { name: "home", path: "/" };
}

export function productPath(productId: string) {
  return `/products/${encodeURIComponent(productId)}`;
}
