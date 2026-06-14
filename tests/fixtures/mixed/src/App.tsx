import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { formatGreeting, onGreeting } from "./actions";

export function GreetingButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick}>Greet</button>;
}

export const App = () => {
  async function greetUser() {
    const name = formatGreeting("Ada");
    await invoke("greet", { name });
    await emit("greeting-sent", name);
  }

  listen("greeting-sent", onGreeting);
  return <GreetingButton onClick={greetUser} />;
};
