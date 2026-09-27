export interface TreeItem { id: string; parents: string[]; text: string }
export interface TreeLine { prefix: string; id: string; text: string; ref?: boolean; cycle?: boolean }

/**
 * Lays items out as a box-drawing tree, in input order. An item sits under its first known parent and shows
 * as a reference row (ref, drawn `→ id`) under any other. Unknown parent ids count as roots; items no root
 * reaches start from a node of their cycle. Rows of items on a cycle get `cycle`. Pure, O(items + edges), never loops.
 */
export function treeLines(items: TreeItem[]): TreeLine[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const parentsOf = new Map<string, string[]>();
	const kids = new Map<string, { id: string; ref: boolean }[]>();
	for (const item of byId.values()) {
		const parents = [...new Set(item.parents)].filter((p) => byId.has(p));
		parentsOf.set(item.id, parents);
		parents.forEach((p, n) => {
			if (!kids.has(p)) kids.set(p, []);
			kids.get(p)!.push({ id: item.id, ref: n > 0 });
		});
	}

	// Tarjan's strongly connected components over parent edges: an item is on a cycle when its component has
	// two or more items or it is its own parent.
	const cyclic = new Set<string>();
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const visit = (id: string) => {
		index.set(id, index.size);
		low.set(id, index.get(id)!);
		stack.push(id);
		onStack.add(id);
		for (const p of parentsOf.get(id)!) {
			if (!index.has(p)) visit(p);
			if (onStack.has(p)) low.set(id, Math.min(low.get(id)!, low.get(p)!));
		}
		if (low.get(id) !== index.get(id)) return;
		const component = stack.splice(stack.lastIndexOf(id));
		component.forEach((c) => onStack.delete(c));
		if (component.length > 1 || parentsOf.get(id)!.includes(id)) component.forEach((c) => cyclic.add(c));
	};
	for (const id of byId.keys()) if (!index.has(id)) visit(id);

	const lines: TreeLine[] = [];
	const drawn = new Set<string>();
	const row = (prefix: string, id: string, ref: boolean) =>
		lines.push({ prefix, id, text: byId.get(id)!.text, ...(ref && { ref }), ...(cyclic.has(id) && { cycle: true }) });
	const draw = (id: string, prefix: string, indent: string) => {
		drawn.add(id);
		row(prefix, id, false);
		const list = kids.get(id) ?? [];
		list.forEach((k, n) => {
			const last = n === list.length - 1;
			const at = indent + (last ? '└─ ' : '├─ ');
			if (!k.ref && !drawn.has(k.id)) draw(k.id, at, indent + (last ? '   ' : '│  '));
			else row(at, k.id, true);
		});
	};

	for (const [id, parents] of parentsOf) if (!parents.length) draw(id, '', '');
	for (const id of byId.keys()) {
		if (drawn.has(id)) continue;
		// Undrawn items all have an undrawn first parent, so walking up must repeat: that node is on a cycle.
		const seen = new Set<string>();
		let at = id;
		while (!seen.has(at)) {
			seen.add(at);
			at = parentsOf.get(at)![0];
		}
		draw(at, '', '');
	}
	return lines;
}
