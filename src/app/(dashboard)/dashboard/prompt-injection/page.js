import PromptInjectionClient from "./PromptInjectionClient";

export const metadata = {
  title: "Prompt Injection | 9Router Pro",
  description: "One injection per target — global, per API key, per model: a single system prompt or a scripted chat, stacked in that order.",
};

export default function PromptInjectionPage() {
  return <PromptInjectionClient />;
}
