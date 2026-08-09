const UPDATE_ACTIVATION_KEY = "piss:update-activation-requested";

type UpdateActivationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function requestUpdateActivation(storage: UpdateActivationStorage = sessionStorage): void {
  storage.setItem(UPDATE_ACTIVATION_KEY, "1");
}

export function consumeUpdateActivation(storage: UpdateActivationStorage = sessionStorage): boolean {
  if (storage.getItem(UPDATE_ACTIVATION_KEY) !== "1") return false;
  storage.removeItem(UPDATE_ACTIVATION_KEY);
  return true;
}
