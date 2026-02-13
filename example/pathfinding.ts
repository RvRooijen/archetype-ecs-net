export interface Point { x: number; y: number }

export function bfs(
  sx: number, sy: number,
  tx: number, ty: number,
  worldSize: number,
  isWalkable: (x: number, y: number) => boolean,
): Point[] {
  if (sx === tx && sy === ty) return [];
  if (!isWalkable(tx, ty)) return [];

  const W = worldSize;
  const visited = new Uint8Array(W * W);
  const parent = new Int16Array(W * W).fill(-1);
  const queue: number[] = [sy * W + sx];
  visited[sy * W + sx] = 1;

  const dirs = [0, -1, 1, 0, 0, 1, -1, 0]; // N E S W

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const cx = idx % W, cy = (idx / W) | 0;

    for (let d = 0; d < 8; d += 2) {
      const nx = cx + dirs[d], ny = cy + dirs[d + 1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const ni = ny * W + nx;
      if (visited[ni] || !isWalkable(nx, ny)) continue;
      visited[ni] = 1;
      parent[ni] = idx;

      if (nx === tx && ny === ty) {
        const path: Point[] = [];
        let cur = ni;
        while (cur !== sy * W + sx) {
          path.push({ x: cur % W, y: (cur / W) | 0 });
          cur = parent[cur];
        }
        path.reverse();
        return path;
      }
      queue.push(ni);
    }
  }
  return [];
}
