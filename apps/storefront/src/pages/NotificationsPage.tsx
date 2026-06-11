import { Bell, CheckCheck } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useStorefront } from "../context/StorefrontContext";

export function NotificationsPage() {
  const { markAllNotificationsRead, notifications, unreadNotificationCount } = useStorefront();

  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-14 md:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <p className="text-xs font-black uppercase tracking-normal text-emerald-700">Notifications</p>
          <h1 className="text-4xl font-black tracking-tight text-emerald-950 md:text-6xl">Activity center</h1>
          <p className="max-w-2xl font-semibold leading-7 text-emerald-900/70">
            Track cart changes, checkout milestones, account updates, promos, and support requests.
          </p>
        </div>
        <Button type="button" variant="outline" className="h-10 border-emerald-200 font-black text-emerald-800 hover:bg-emerald-50" onClick={markAllNotificationsRead} disabled={notifications.length === 0 || unreadNotificationCount === 0}>
          <CheckCheck className="size-4" aria-hidden="true" />
          <span>Mark all read</span>
        </Button>
      </div>

      {notifications.length > 0 ? (
        <section className="grid gap-3">
          {notifications.map((notification) => (
            <Card key={notification.id} className={`rounded-lg border-emerald-100 shadow-xl shadow-emerald-950/5 ${notification.read ? "bg-white" : "bg-emerald-50"}`}>
              <CardContent className="grid gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-black text-emerald-950">{notification.title}</h2>
                  <span className="rounded-full bg-white px-2 py-1 text-xs font-black uppercase text-emerald-700">{notification.type}</span>
                </div>
                <p className="font-semibold leading-6 text-emerald-900/75">{notification.body}</p>
                <span className="text-sm font-bold text-emerald-700">{new Date(notification.created_at).toLocaleString()}</span>
              </CardContent>
            </Card>
          ))}
        </section>
      ) : (
        <Card className="rounded-lg border-emerald-100 bg-white shadow-xl shadow-emerald-950/5">
          <CardContent className="grid min-h-72 justify-items-start gap-4 p-6">
            <Bell className="size-11 text-emerald-600" aria-hidden="true" />
            <h2 className="text-3xl font-black tracking-tight text-emerald-950">No notifications yet</h2>
            <p className="max-w-xl font-semibold leading-7 text-emerald-900/70">
              Shopping, checkout, and support actions will appear here.
            </p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
