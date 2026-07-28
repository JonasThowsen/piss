import { useCallback, useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import { loadNotificationCapability, updatePushSubscription } from "./api.ts";

export type NotificationStatus = "loading" | "available" | "permitted" | "prompt" | "enabling" | "enabled" | "denied" | "unavailable" | "error";

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

function serialized(subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("Browser returned an invalid push subscription");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

function unsubscribedStatus(): NotificationStatus {
  return Notification.permission === "denied" ? "denied" : Notification.permission === "granted" ? "permitted" : "available";
}

export function useNotifications() {
  const [status, setStatus] = useState<NotificationStatus>("loading");
  const [error, setError] = useState<string>();
  const [vapidKey, setVapidKey] = useState<string>();
  const operationPending = useRef(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    let cancelled = false;
    let supported = false;
    const inspect = async (showLoading: boolean) => {
      if (operationPending.current) return;
      if (showLoading) setStatus("loading");
      try {
        const capability = await Effect.runPromise(loadNotificationCapability);
        if (cancelled) return;
        supported = capability.supported && Boolean(capability.vapidPublicKey) && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
        if (!supported || !capability.vapidPublicKey) {
          setStatus("unavailable");
          return;
        }
        setVapidKey(capability.vapidPublicKey);
        const registration = await navigator.serviceWorker.ready;
        registrationRef.current = registration;
        const subscription = await registration.pushManager.getSubscription();
        if (cancelled || operationPending.current) return;
        if (!subscription) {
          setError(undefined);
          setStatus(unsubscribedStatus());
          return;
        }
        await Effect.runPromise(updatePushSubscription({ action: "subscribe", subscription: serialized(subscription) }));
        if (!cancelled && !operationPending.current) {
          setError(undefined);
          setStatus("enabled");
        }
      } catch (cause) {
        if (cancelled || operationPending.current) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Could not inspect notification support");
      }
    };
    void inspect(true);
    const refresh = () => { if (document.visibilityState === "visible" && supported) void inspect(false); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);

  const finishSubscription = useCallback(async () => {
    if (!vapidKey || operationPending.current) return;
    operationPending.current = true;
    setStatus("enabling");
    setError(undefined);
    try {
      const registration = registrationRef.current;
      if (!registration) throw new Error("The notification service worker is not ready; reload and try again");

      // Invoke subscribe before the first await so a direct tap retains its
      // transient activation. Chrome 155 may also allow this after permission
      // changes through its address-bar Site Controls.
      const subscriptionPromise = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(vapidKey),
      });
      const subscription = await subscriptionPromise;
      await Effect.runPromise(updatePushSubscription({ action: "subscribe", subscription: serialized(subscription) }));
      setStatus("enabled");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError" && Notification.permission === "granted") {
        setStatus("permitted");
      } else {
        setStatus("error");
        setError(cause instanceof Error ? `${cause.name}: ${cause.message}` : "Could not enable notifications");
      }
    } finally {
      operationPending.current = false;
    }
  }, [vapidKey]);

  useEffect(() => {
    if (!vapidKey || !("permissions" in navigator)) return;
    let cancelled = false;
    let permissionStatus: PermissionStatus | undefined;
    const changed = () => {
      if (cancelled || !permissionStatus) return;
      if (permissionStatus.state === "granted") void finishSubscription();
      else if (permissionStatus.state === "denied") setStatus("denied");
    };
    void navigator.permissions.query({ name: "notifications" }).then((result) => {
      if (cancelled) return;
      permissionStatus = result;
      permissionStatus.addEventListener("change", changed);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      permissionStatus?.removeEventListener("change", changed);
    };
  }, [finishSubscription, vapidKey]);

  const enable = useCallback(async () => {
    if (!vapidKey || operationPending.current) return;
    if (Notification.permission === "granted") return finishSubscription();

    operationPending.current = true;
    setStatus("enabling");
    setError(undefined);
    try {
      const permission = await Notification.requestPermission();
      setStatus(permission === "granted" ? "permitted" : permission === "denied" ? "denied" : "prompt");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? `${cause.name}: ${cause.message}` : "Could not request notification permission");
    } finally {
      operationPending.current = false;
    }
  }, [finishSubscription, vapidKey]);

  const disable = useCallback(async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setError(undefined);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await Effect.runPromise(updatePushSubscription({ action: "unsubscribe", endpoint: subscription.endpoint }));
        await subscription.unsubscribe();
      }
      setStatus(unsubscribedStatus());
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Could not disable notifications");
    } finally {
      operationPending.current = false;
    }
  }, []);

  return { status, error, enable, disable };
}
