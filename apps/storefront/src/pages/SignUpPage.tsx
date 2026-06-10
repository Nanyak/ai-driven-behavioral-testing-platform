import { AuthForm } from "../components/AuthForm";
import { useStorefront } from "../context/StorefrontContext";

type SignUpPageProps = {
  onNavigate: (path: string) => void;
};

export function SignUpPage({ onNavigate }: SignUpPageProps) {
  const { authEmail, authPassword, isBusy, registerCustomer, setAuthEmail, setAuthPassword } = useStorefront();

  async function handleSubmit() {
    if (await registerCustomer()) {
      onNavigate("/profile");
    }
  }

  return (
    <main className="grid min-h-[calc(100vh-76px)] place-items-start justify-center px-4 py-16">
      <AuthForm
        email={authEmail}
        password={authPassword}
        mode="signup"
        isBusy={isBusy}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onNavigate={onNavigate}
        onSubmit={handleSubmit}
      />
    </main>
  );
}
