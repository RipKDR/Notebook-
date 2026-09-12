import { AppState } from "react-native";

export function bindAppStateSync(run: () => void, watchAppState: boolean): () => void {
  if (!watchAppState) return () => undefined;
  if (AppState.currentState === "active") run();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") run();
  });
  return () => subscription.remove();
}
