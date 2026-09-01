import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the Dark Draft Huddle", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: /welcome back, coach/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tater Wire")).toBeInTheDocument();
    expect(screen.getByText("Potato Bowl After Dark")).toBeInTheDocument();
  });
});
