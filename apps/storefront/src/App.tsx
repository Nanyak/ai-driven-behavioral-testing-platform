import { useEffect } from "react";
import { StoreHeader } from "./components/StoreHeader";
import { StorefrontProvider, useStorefront } from "./context/StorefrontContext";
import { useRoute } from "./hooks/useRoute";
import { CartPage } from "./pages/CartPage";
import { CollectionPage } from "./pages/CollectionPage";
import { DealsPage } from "./pages/DealsPage";
import { HomePage } from "./pages/HomePage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OrderPage } from "./pages/OrderPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ProductPage } from "./pages/ProductPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { SellerPage } from "./pages/SellerPage";
import { WishlistPage } from "./pages/WishlistPage";

function StorefrontRoutes() {
  const { route, navigate } = useRoute();
  const { customer, isCustomerAuthenticated, itemCount, searchQuery, setSearchQuery, status, unreadNotificationCount, wishlistProductIds } = useStorefront();

  useEffect(() => {
    if (route.name === "cart" && !isCustomerAuthenticated) {
      navigate("/signin");
    }
  }, [isCustomerAuthenticated, route.name]);

  return (
    <div className="min-h-screen bg-slate-50 pb-14 text-slate-900">
      <StoreHeader
        itemCount={itemCount}
        customerEmail={customer?.email}
        isCustomerAuthenticated={isCustomerAuthenticated}
        searchQuery={searchQuery}
        status={status}
        unreadNotificationCount={unreadNotificationCount}
        wishlistCount={wishlistProductIds.length}
        onNavigate={navigate}
        onSearchChange={setSearchQuery}
      />
      {route.name === "home" ? <HomePage onNavigate={navigate} /> : null}
      {route.name === "deals" ? <DealsPage onNavigate={navigate} /> : null}
      {route.name === "product" ? <ProductPage productId={route.productId} onNavigate={navigate} /> : null}
      {route.name === "collection" ? <CollectionPage collectionName={route.collectionName} onNavigate={navigate} /> : null}
      {route.name === "seller" ? <SellerPage sellerName={route.sellerName} onNavigate={navigate} /> : null}
      {route.name === "signin" ? <SignInPage onNavigate={navigate} /> : null}
      {route.name === "signup" ? <SignUpPage onNavigate={navigate} /> : null}
      {route.name === "profile" ? <ProfilePage onNavigate={navigate} /> : null}
      {route.name === "wishlist" ? <WishlistPage onNavigate={navigate} /> : null}
      {route.name === "orders" ? <OrdersPage onNavigate={navigate} /> : null}
      {route.name === "notifications" ? <NotificationsPage /> : null}
      {route.name === "cart" && isCustomerAuthenticated ? <CartPage onNavigate={navigate} /> : null}
      {route.name === "order" ? <OrderPage orderId={route.orderId} onNavigate={navigate} /> : null}
    </div>
  );
}

export function App() {
  return (
    <StorefrontProvider>
      <StorefrontRoutes />
    </StorefrontProvider>
  );
}
