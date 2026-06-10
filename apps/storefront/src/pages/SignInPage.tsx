import { AuthForm } from "../components/AuthForm";
import { useStorefront } from "../context/StorefrontContext";

type SignInPageProps = {
  onNavigate: (path: string) => void;
};

export function SignInPage({ onNavigate }: SignInPageProps) {
  const { authEmail, authPassword, isBusy, loginCustomer, setAuthEmail, setAuthPassword } = useStorefront();

  async function handleSubmit() {
    if (await loginCustomer()) {
      onNavigate("/profile");
    }
  }

  return (
    <main className="grid min-h-[calc(100vh-76px)] place-items-start justify-center px-4 py-16">
      <AuthForm
        email={authEmail}
        password={authPassword}
        mode="signin"
        isBusy={isBusy}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onNavigate={onNavigate}
        onSubmit={handleSubmit}
      />
    </main>
  );
}
