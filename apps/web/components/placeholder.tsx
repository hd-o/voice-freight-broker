"use client";

import { useState } from "react";
import { renderButton as Button } from "./ui/button";

export function renderPlaceholder() {
  const [status, setStatus] = useState("Check interaction");
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-5 p-8">
      <h1 className="text-3xl font-semibold">Voice Freight Broker</h1>
      <p>Development environment. Product features are not implemented yet.</p>
      <Button onClick={() => setStatus("Interaction verified")}>
        {status}
      </Button>
    </main>
  );
}
