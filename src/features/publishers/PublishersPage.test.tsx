import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PublishersPage from "./PublishersPage";
import { fetchPublishers, savePublisherPreferences, updatePublisher, type Publisher } from "./publishers-api";

const access = vi.hoisted(() => ({ ownerToken: "", google: true, isOwner: true, canRead: true }));
vi.mock("../research/useResearchOwnerAccess", () => ({ useResearchOwnerAccess: () => access }));
vi.mock("./publishers-api", () => ({ fetchPublishers: vi.fn(), savePublisherPreferences: vi.fn(), updatePublisher: vi.fn() }));
const publisher: Publisher = { id: "publisher:example.com", domain: "example.com", name: "Example Experts", url: "https://example.com", blocked: false, archived: false, notes: "", tags: [], favorite: false, excluded: false, kinds: ["rankings", "sleepers"], firstSeenAt: "2026-09-01", lastSeenAt: "2026-09-05", rankingSourceIds: ["source-1"] };
beforeEach(() => {
  access.isOwner = true;
  vi.mocked(fetchPublishers).mockResolvedValue({ publishers: [publisher] });
  vi.mocked(savePublisherPreferences).mockResolvedValue({ publisher });
  vi.mocked(updatePublisher).mockResolvedValue({ publisher });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("publisher library", () => {
  it("filters by name, status and research type", async () => {
    render(<PublishersPage />); await screen.findByText("Example Experts");
    fireEvent.change(screen.getByLabelText("Find a publisher"), { target: { value: "example" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "blocked" } });
    fireEvent.change(screen.getByLabelText("Research type"), { target: { value: "sleepers" } });
    await waitFor(() => expect(vi.mocked(fetchPublishers).mock.calls.at(-1)?.[1]?.toString()).toBe("search=example&status=blocked&kind=sleepers"));
  });
  it("lets viewers favorite and exclude without global moderation controls", async () => {
    access.isOwner = false; render(<PublishersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Favorite" }));
    await waitFor(() => expect(savePublisherPreferences).toHaveBeenCalledWith("", publisher.id, { favorite: true }));
    await waitFor(() => expect(screen.getByLabelText("Exclude from my current results")).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Exclude from my current results"));
    await waitFor(() => expect(savePublisherPreferences).toHaveBeenCalledWith("", publisher.id, { excluded: true }));
    expect(screen.queryByRole("button", { name: "Block research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(updatePublisher).not.toHaveBeenCalled();
  });
  it("requires confirmation to block and archives without deleting history", async () => {
    render(<PublishersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Block research" }));
    expect(updatePublisher).not.toHaveBeenCalled();
    expect(screen.getByText(/Historical reports remain intact/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm block" }));
    await waitFor(() => expect(updatePublisher).toHaveBeenCalledWith("", publisher.id, { blocked: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(updatePublisher).toHaveBeenCalledWith("", publisher.id, { archived: true }));
  });
});
