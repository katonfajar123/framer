import { describe, expect, it } from "vitest";
import type { FolderNode } from "../lib/api";
import { chainFor, childrenOf, pathKey } from "./folders";

function node(path: string, parent: string | null, extra: Partial<FolderNode> = {}): FolderNode {
  return {
    path,
    name: path.split("\\").pop()!,
    parent,
    sourceId: 1,
    directCount: 1,
    totalCount: 1,
    isRoot: parent === null,
    available: true,
    coverId: null,
    ...extra,
  };
}

const tree = [
  node(String.raw`D:\Photos`, null),
  node(String.raw`D:\Photos\Trips`, String.raw`D:\Photos`),
  node(String.raw`D:\Photos\Trips\Bali`, String.raw`D:\Photos\Trips`),
  node(String.raw`D:\Photos\Trips\Lombok 10`, String.raw`D:\Photos\Trips`),
  node(String.raw`D:\Photos\Trips\Lombok 2`, String.raw`D:\Photos\Trips`),
  node(String.raw`E:\Backup`, null, { sourceId: 2 }),
];

describe("pathKey", () => {
  it("ignores case, slash direction and trailing separators", () => {
    expect(pathKey("D:/Photos/Trips/")).toBe(pathKey(String.raw`d:\photos\trips`));
  });
});

describe("childrenOf", () => {
  it("lists source roots when no parent is given", () => {
    expect(childrenOf(tree, null).map((entry) => entry.name)).toEqual(["Backup", "Photos"]);
  });

  it("lists direct children in natural order, case-insensitively", () => {
    expect(childrenOf(tree, String.raw`d:\photos\TRIPS`).map((entry) => entry.name)).toEqual(["Bali", "Lombok 2", "Lombok 10"]);
    expect(childrenOf(tree, String.raw`D:\Photos\Trips\Bali`)).toEqual([]);
  });
});

describe("chainFor", () => {
  it("returns the ancestors from the source root down to the folder", () => {
    expect(chainFor(tree, String.raw`D:\Photos\Trips\Bali`).map((entry) => entry.name)).toEqual(["Photos", "Trips", "Bali"]);
    expect(chainFor(tree, String.raw`E:\Backup`).map((entry) => entry.name)).toEqual(["Backup"]);
  });

  it("returns nothing for a folder that is not in the tree", () => {
    expect(chainFor(tree, String.raw`Z:\Nowhere`)).toEqual([]);
  });
});
