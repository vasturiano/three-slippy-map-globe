import { yMercatorScaleInvert } from './mercator.js';

export default function genLevel(level, isMercator) {
  const tiles = [];

  const gridSize = 2 ** level;
  const tileLngLen = 360 / gridSize;
  const regTileLatLen = 180 / gridSize;
  for (let x = 0; x < gridSize; x++) {
    for (let y = 0; y < gridSize; y++) {
      let reproY = y, tileLatLen = regTileLatLen;

      if (isMercator) {
        // lat needs reprojection, but stretch to cover poles
        reproY = y === 0 ? y : yMercatorScaleInvert(y / gridSize) * gridSize;
        const reproYEnd = y + 1 === gridSize ? y + 1 : yMercatorScaleInvert((y + 1) / gridSize) * gridSize;
        tileLatLen = (reproYEnd - reproY) * 180 / gridSize;
      }

      // tile centroid coordinates
      const lng = -180 + (x + 0.5) * tileLngLen;
      const lat = 90 - (reproY * 180 / gridSize + tileLatLen / 2);
      const latLen = tileLatLen; // lng is always constant among all tiles

      tiles.push({ x, y, lng, lat, latLen });
    }
  }

  return tiles;
}
