import { yMercatorScale, yMercatorScaleInvert } from './mercator.js';

export const findTileXY = (level, isMercator, lng, lat) => {
  const gridSize = 2 ** level;
  const x = Math.max(0, Math.min(gridSize - 1, Math.floor((lng + 180) * gridSize / 360)));
  let relY = (90 - lat) / 180;
  isMercator && (relY = Math.max(0, Math.min(1, yMercatorScale(relY))));
  const y = Math.floor(relY * gridSize);
  return [x, y];
}

const genTilesCoords = (level, isMercator, x0 = 0, y0 = 0, _x1, _y1) => {
  const tiles = [];

  const gridSize = 2 ** level;
  const tileLngLen = 360 / gridSize;
  const regTileLatLen = 180 / gridSize;

  const x1 = _x1 === undefined ? gridSize - 1 : _x1;
  const y1 = _y1 === undefined ? gridSize - 1 : _y1;

  for (let x = x0, maxX = Math.min(gridSize - 1, x1); x <= maxX; x++) {
    for (let y = y0, maxY = Math.min(gridSize - 1, y1); y <= maxY; y++) {
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

export default genTilesCoords;