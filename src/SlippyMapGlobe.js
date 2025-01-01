import {
  Camera,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3
} from 'three';

import { emptyObject } from "./utils/gc.js";
import { polar2Cartesian, deg2Rad } from "./utils/coordTranslate.js";
import { yMercatorScaleInvert, convertMercatorUV } from './utils/mercator.js';

export default class ThreeSlippyMapGlobe extends Group {
  constructor(radius, {
    tileUrl,
    mercatorProjection = true
  } = {}) {
    super();
    this.#radius = radius;
    this.tileUrl = tileUrl;
    this.#isMercator = mercatorProjection;
    this.level = 0;
  }

  // Public attributes
  tileUrl;
  thresholds = [4, 2, 1, 1/2, 1/4, 1/8, 1/16, 1/32, 1/64, 1/128]; // in terms of radius units
  curvatureResolution = 5; // in degrees, affects number of vertices in tiles
  tileMargin = 0;
  get level() { return this.#level }
  set level(level) {
    if (level === this.#level && this.#tilesMeta.length) return; // nothing to do

    this.#level = level;

    // Wipe existing tiles
    emptyObject(this);

    // Rebuild tiles meta
    this.#tilesMeta.forEach(d => d.discard = true);
    this.#tilesMeta = [];
    const gridSize = 2 ** level;
    const tileLngLen = 360 / gridSize;
    const regTileLatLen = 180 / gridSize;
    for (let x = 0; x < gridSize; x++) {
      for (let y = 0; y < gridSize; y++) {
        let reproY = y,
          tileLatLen = regTileLatLen;
        if (this.#isMercator) {
          // lat needs reprojection
          reproY = yMercatorScaleInvert(y / gridSize) * gridSize;
          const reproYEnd = yMercatorScaleInvert((y + 1) / gridSize) * gridSize;
          tileLatLen = (reproYEnd - reproY) * 180 / gridSize;
        }

        const lng0 = -180 + x * tileLngLen;
        const lng1 = lng0 + tileLngLen;
        const lat0 = 90 - (reproY * 180 / gridSize);
        const lat1 = lat0 - tileLatLen;
        const hullPnts = [
          [lat0, lng0],
          [lat1, lng0],
          [lat0, lng1],
          [lat1, lng1],
          [lat0 - tileLatLen / 2, lng0 + tileLngLen / 2],
        ].map(c => polar2Cartesian(...c, this.#radius)).map(({ x, y, z }) => new Vector3(x, y, z));

        this.#tilesMeta.push({
          x,
          y,
          lat0,
          lat1,
          lng0,
          lng1,
          hullPnts,
          fetched: false
        });
      }
    }

    this.#fetchNeededTiles();
  }

  // Public methods
  updatePov(camera) {
    if (!camera || !(camera instanceof Camera)) return;

    const pov = camera.position;
    const distToGlobeCenter = pov.distanceTo(this.getWorldPosition(new Vector3()));
    const cameraDistance = (distToGlobeCenter - this.#radius) / this.#radius; // in units of globe radius

    let frustum;
    this.#isInView = pos => {
      const wPos = pos.clone().applyMatrix4(this.matrixWorld);

      if (!frustum) {
        camera.updateMatrix();
        camera.updateMatrixWorld();
        frustum = new Frustum();
        frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      }

      if (!frustum.containsPoint(wPos)) return false; // point out of view

      // simplistic way to check if it's behind globe: if it's farther than the center of the globe
      return pov.distanceTo(wPos) < distToGlobeCenter;
    }

    //

    if (!this.tileUrl || cameraDistance <= 0) {
      this.level = 0;
    } else {
      const idx = this.thresholds.findIndex(t => t && t <= cameraDistance);
      this.level = idx < 0 ? this.thresholds.length : idx;
    }

    this.#fetchNeededTiles();
  }

  // Private attributes
  #radius;
  #isMercator;
  #level;
  #tilesMeta = [];
  #isInView;

  // Private methods
  #fetchNeededTiles() {
    if (!this.tileUrl) return;

    // Safety if can't check in view tiles for higher levels
    if (!this.#isInView && this.level > 4) return;

    this.#tilesMeta
      .filter(d => !d.fetched && !d.discard)
      .forEach((d) => {
        if (!this.#isInView || d.hullPnts.some(this.#isInView)) {
          // Fetch tile
          d.fetched = true;
          d.loading = true;

          const { x, y, lat0, lat1, lng0, lng1 } = d;

          const width = (lng1 - lng0) * (1 - this.tileMargin);
          const height = (lat0 - lat1) * (1 - this.tileMargin);
          const rotLng = deg2Rad((lng0 + lng1) / 2);
          const rotLat = deg2Rad(-(lat0 + lat1) / 2);
          const tile = new Mesh(
            new SphereGeometry(
              this.#radius,
              Math.ceil(width / this.curvatureResolution),
              Math.ceil(height / this.curvatureResolution),
              deg2Rad(90 - width / 2) + rotLng,
              deg2Rad(width),
              deg2Rad(90 - height / 2) + rotLat,
              deg2Rad(height)
            ),
            new MeshLambertMaterial()
          );
          this.#isMercator && convertMercatorUV(tile.geometry.attributes.uv, 0.5 - (lat0 / 180), 0.5 - (lat1 / 180));

          new TextureLoader().load(this.tileUrl(x, y, this.level), texture => {
            d.loading = false;
            if (!d.discard) {
              texture.colorSpace = SRGBColorSpace;
              tile.material.map = texture;
              tile.material.color = null;
              tile.material.needsUpdate = true;

              this.add(tile);
            }
          });

          d.obj = tile;
        }
      });
    }
}
