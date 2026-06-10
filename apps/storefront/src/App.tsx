import { StoreHeader } from "./components/StoreHeader";
import { StorefrontProvider, useStorefront } from "./context/StorefrontContext";
import { useRoute } from "./hooks/useRoute";
import { CartPage } from "./pages/CartPage";
import { HomePage } from "./pages/HomePage";
import { ProductPage } from "./pages/ProductPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";

function StorefrontRoutes() {
  const { route, navigate } = useRoute();
  const { customer, itemCount, status } = useStorefront();

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7fee7_0%,#f8fafc_45%,#ffffff_100%)] pb-14 text-emerald-950">
      <StoreHeader itemCount={itemCount} customerEmail={customer?.email} status={status} onNavigate={navigate} />
      {route.name === "home" ? <HomePage onNavigate={navigate} /> : null}
      {route.name === "product" ? <ProductPage productId={route.productId} onNavigate={navigate} /> : null}
      {route.name === "signin" ? <SignInPage onNavigate={navigate} /> : null}
      {route.name === "signup" ? <SignUpPage onNavigate={navigate} /> : null}
      {route.name === "profile" ? <ProfilePage onNavigate={navigate} /> : null}
      {route.name === "cart" ? <CartPage onNavigate={navigate} /> : null}
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
