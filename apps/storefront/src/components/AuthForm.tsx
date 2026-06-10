import { LogIn, Plus } from "lucide-react";
import { AppLink } from "./AppLink";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type AuthFormProps = {
  email: string;
  mode: "signin" | "signup";
  password: string;
  isBusy: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onNavigate: (path: string) => void;
  onSubmit: () => void;
};

export function AuthForm({
  email,
  mode,
  password,
  isBusy,
  onEmailChange,
  onPasswordChange,
  onNavigate,
  onSubmit,
}: AuthFormProps) {
  const isSignIn = mode === "signin";

  return (
    <Card className="w-full max-w-md rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
      <CardContent className="grid gap-6 p-6">
        <div className="grid gap-2">
          <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Account</p>
          <h1 className="text-4xl font-black tracking-tight text-emerald-950">{isSignIn ? "Sign in" : "Create account"}</h1>
          <p className="font-semibold leading-7 text-emerald-900/70">
            {isSignIn ? "Continue as a returning shopper." : "Set up a shopper profile for checkout testing."}
          </p>
        </div>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${mode}-email`} className="font-black text-emerald-950">
              Email
            </Label>
            <Input id={`${mode}-email`} className="h-11 border-emerald-200 font-semibold focus-visible:border-emerald-500 focus-visible:ring-emerald-500/15" type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${mode}-password`} className="font-black text-emerald-950">
              Password
            </Label>
            <Input
              id={`${mode}-password`}
              className="h-11 border-emerald-200 font-semibold focus-visible:border-emerald-500 focus-visible:ring-emerald-500/15"
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </div>
          <Button type="button" className="h-11 bg-orange-500 font-black text-white hover:bg-orange-600" onClick={onSubmit} disabled={isBusy}>
            {isSignIn ? <LogIn className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
            <span>{isSignIn ? "Sign in" : "Create account"}</span>
          </Button>
        </div>
        <p className="font-semibold text-emerald-900/70">
          {isSignIn ? "Need an account?" : "Already have an account?"}{" "}
          <AppLink className="font-black text-emerald-700 hover:text-emerald-900" to={isSignIn ? "/signup" : "/signin"} onNavigate={onNavigate}>
            {isSignIn ? "Sign up" : "Sign in"}
          </AppLink>
        </p>
      </CardContent>
    </Card>
  );
}
