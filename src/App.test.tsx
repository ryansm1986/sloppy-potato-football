import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  afterEach(cleanup);
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

  it("routes runner configuration to Settings", () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Owner access" })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Settings" })) expect(link).toHaveClass("is-active");
  });
});
