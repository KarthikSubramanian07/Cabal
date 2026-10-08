import { describe, expect, it } from "vitest";
import { appendVaryAccept, markdownPath, normalizePath, preferredType } from "./negotiate.js";

describe("preferredType", () => {
  it("defaults to the first produced type when Accept is missing", () => {
    expect(preferredType(null, ["text/html", "text/markdown"])).toBe("text/html");
  });

  it("prefers markdown when listed first among equals", () => {
    expect(preferredType("text/markdown, text/html", ["text/html", "text/markdown"])).toBe(
      "text/markdown",
    );
  });

  it("honours q-values and explicit rejections", () => {
    expect(preferredType("text/html;q=0.1, text/markdown;q=0.9", ["text/html", "text/markdown"])).toBe(
      "text/markdown",
    );
    expect(preferredType("text/html;q=0, text/markdown", ["text/html", "text/markdown"])).toBe(
      "text/markdown",
    );
    expect(preferredType("text/html;q=0, text/markdown;q=0", ["text/html", "text/markdown"])).toBe(null);
  });

  it("does not let */* override a more specific q=0 rejection", () => {
    expect(preferredType("text/html;q=0, */*;q=1", ["text/html", "text/markdown"])).toBe("text/markdown");
  });
});

describe("path helpers", () => {
  it("maps routes to markdown siblings", () => {
    expect(markdownPath("/")).toBe("/index.md");
    expect(markdownPath("/about")).toBe("/about/index.md");
    expect(markdownPath("/about/")).toBe("/about/index.md");
    expect(markdownPath("/404")).toBe("/404.md");
  });

  it("normalizes trailing slashes", () => {
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("/")).toBe("/");
  });

  it("appends Vary: Accept without duplicating", () => {
    const headers = new Headers({ Vary: "Accept-Encoding" });
    appendVaryAccept(headers);
    appendVaryAccept(headers);
    expect(headers.get("Vary")?.toLowerCase()).toContain("accept-encoding");
    expect(headers.get("Vary")?.toLowerCase().split(",").map((s) => s.trim())).toContain("accept");
  });
});
