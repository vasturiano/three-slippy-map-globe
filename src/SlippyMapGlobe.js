import {
  Camera,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3
} from 'three';

import { octree as d3Octree } from 'd3-octree';

import { emptyObject } from "./utils/gc.js";
import { deg2Rad, polar2Cartesian, cartesian2Polar } from './utils/coordTranslate.js';
import { convertMercatorUV } from './utils/mercator.js';
import genTiles, { findTileXY } from './utils/tileGenerator.js';

const MAX_LEVEL_TO_RENDER_ALL_TILES = 6; // level 6 = 4096 tiles
const MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE = 7; // octrees consume too much memory on higher levels, generate tiles on demand for those (based on globe surface distance) as the distortion is negligible
const TILE_SEARCH_RADIUS_CAMERA_DISTANCE = 3; // Euclidean distance factor, in units of camera distance to surface
const TILE_SEARCH_RADIUS_SURFACE_DISTANCE = 90; // in degrees on the globe surface, relative to camera altitude in globe radius units

export default class ThreeSlippyMapGlobe extends Group {
  constructor(radius, {
    tileUrl,
    minLevel = 0,
    maxLevel = 17,
    mercatorProjection = true
  } = {}) {
    super();
    this.#radius = radius;
    this.tileUrl = tileUrl;
    this.#isMercator = mercatorProjection;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
    this.level = 0;

    // Add protective black sphere just below surface to prevent any depth buffer anomalies
    this.add(this.#innerBackLayer = new Mesh(
      new SphereGeometry(this.#radius * 0.99, 180, 90),
      new MeshBasicMaterial({ color: 0x0 })
    ));
    this.#innerBackLayer.visible = false;
    this.#innerBackLayer.material.polygonOffset = true;
    this.#innerBackLayer.material.polygonOffsetUnits = 3;
    this.#innerBackLayer.material.polygonOffsetFactor = 1;
  }

  // Private attributes
  #radius;
  #isMercator;
  #tileUrl;
  #level;
  #tilesMeta = {};
  #isInView;
  #camera;
  #innerBackLayer;

  // Public attributes
  get tileUrl() { return this.#tileUrl }
  set tileUrl(tileUrl) {
    this.#tileUrl = tileUrl;
    this.updatePov(this.#camera); // update current view
  }
  minLevel;
  maxLevel;
  thresholds = [...new Array(30)].map((_, idx) => 8 / 2**idx); // in terms of radius units
  curvatureResolution = 5; // in degrees, affects number of vertices in tiles
  tileMargin = 0;
  get level() { return this.#level }
  set level(level) {
    if (!this.#tilesMeta[level]) this.#buildMetaLevel(level);

    const prevLevel = this.#level;
    this.#level = level;

    if (level === prevLevel || prevLevel === undefined) return; // nothing else to do

    // Activate back layer for levels > 0, when there's !depthWrite tiles
    this.#innerBackLayer.visible = level > 0;

    // Bring layer to front
    this.#tilesMeta[level].forEach(d => d.obj && (d.obj.material.depthWrite = true));

    // push lower layers to background
    prevLevel < level && this.#tilesMeta[prevLevel]?.forEach(d => d.obj && (d.obj.material.depthWrite = false));

    // Remove upper layers
    if (prevLevel > level) {
      for (let l = level + 1; l <= prevLevel; l++) {
        this.#tilesMeta[l] && this.#tilesMeta[l].forEach(d => {
          if (d.obj) {
            this.remove(d.obj);
            emptyObject(d.obj);
            delete d.obj;
          }
        });
      }
    }

    this.#fetchNeededTiles();
  }

  // Public methods
  updatePov(camera) {
    if (!camera || !(camera instanceof Camera)) return;

    this.#camera = camera;

    let frustum;
    this.#isInView = d => {
      if (!d.hullPnts) { // cached for next time to improve performance
        const lngLen = 360 / (2**this.level);
        const { lng, lat, latLen } = d;
        const lng0 = lng - lngLen / 2;
        const lng1 = lng + lngLen / 2;
        const lat0 = lat - latLen / 2;
        const lat1 = lat + latLen / 2;
        d.hullPnts = [[lat, lng], [lat0, lng0], [lat1, lng0], [lat0, lng1], [lat1, lng1]]
          .map(([lat, lng]) => polar2Cartesian(lat, lng, this.#radius))
          .map(({ x, y, z }) => new Vector3(x, y, z));
      }

      if (!frustum) {
        frustum = new Frustum();
        camera.updateMatrix();
        camera.updateMatrixWorld();
        frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      }

      return d.hullPnts.some(pos =>
        frustum.containsPoint(pos.clone().applyMatrix4(this.matrixWorld))
      );
    }

    if (this.tileUrl) {
      const pov = camera.position.clone();
      const distToGlobeCenter = pov.distanceTo(this.getWorldPosition(new Vector3()));
      const cameraDistance = (distToGlobeCenter - this.#radius) / this.#radius; // in units of globe radius

      const idx = this.thresholds.findIndex(t => t && t <= cameraDistance);
      this.level = Math.min(this.maxLevel, Math.max(this.minLevel, idx < 0 ? this.thresholds.length : idx));
      this.#fetchNeededTiles();
    }
  }

  clearTiles = () => {
    Object.values(this.#tilesMeta).forEach(l => {
      l.forEach(d => {
        if (d.obj) {
          this.remove(d.obj);
          emptyObject(d.obj);
          delete d.obj;
        }
      });
    });
    this.#tilesMeta = {};
  }

  // Private methods
  #buildMetaLevel(level) {
    if (level > MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE) {
      // Generate meta dynamically
      this.#tilesMeta[level] = [];
      return;
    }

    // Generate distance lookup octree
    const levelMeta = this.#tilesMeta[level] = genTiles(level, this.#isMercator);
    levelMeta.forEach(d => d.centroid = polar2Cartesian(d.lat, d.lng, this.#radius));
    levelMeta.octree = d3Octree()
      .x(d => d.centroid.x)
      .y(d => d.centroid.y)
      .z(d => d.centroid.z)
      .addAll(levelMeta);
  }

  #fetchNeededTiles(){
    if (!this.tileUrl || this.level === undefined || !this.#tilesMeta.hasOwnProperty(this.level)) return;

    // Safety if can't check in view tiles for higher levels
    if (!this.#isInView && this.level > MAX_LEVEL_TO_RENDER_ALL_TILES) return;

    let tiles = this.#tilesMeta[this.level];
    if (this.#camera) { // Pre-select tiles close to the camera
      const povPos = this.worldToLocal(this.#camera.position.clone());

      if (tiles.octree) { // Octree based on 3d positions is more accurate
        const povPos = this.worldToLocal(this.#camera.position.clone());
        const searchRadius = (povPos.length() - this.#radius) * TILE_SEARCH_RADIUS_CAMERA_DISTANCE;
        tiles = tiles.octree.findAllWithinRadius(...povPos, searchRadius);
      } else { // tiles populated dynamically
        const povCoords = cartesian2Polar(povPos);
        const searchRadiusLat = (povCoords.r / this.#radius - 1) * TILE_SEARCH_RADIUS_SURFACE_DISTANCE;
        const searchRadiusLng = searchRadiusLat / Math.cos(deg2Rad(povCoords.lat)); // Distances in longitude degrees shrink towards the poles
        const lngRange = [povCoords.lng - searchRadiusLng, povCoords.lng + searchRadiusLng];
        const latRange = [povCoords.lat + searchRadiusLat, povCoords.lat - searchRadiusLat];

        const [x0, y0] = findTileXY(this.level, this.#isMercator, lngRange[0], latRange[0]);
        const [x1, y1] = findTileXY(this.level, this.#isMercator, lngRange[1], latRange[1]);

        !tiles.record && (tiles.record = {}); // Index gen tiles by XY
        const r = tiles.record;

        if (!r.hasOwnProperty(`${Math.round((x0+x1)/2)}_${Math.round((y0+y1)/2)}`)) { // gen all found tiles if middle one is not in record
          tiles = genTiles(this.level, this.#isMercator, x0, y0, x1, y1)
            .map(d => {
              const k = `${d.x}_${d.y}`;
              if (r.hasOwnProperty(k)) return r[k];

              r[k] = d;
              tiles.push(d);
              return d;
            });
        } else { // gen only those missing, one by one
          const selTiles = [];
          for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
              const k = `${x}_${y}`;
              if (!r.hasOwnProperty(k)) {
                r[k] = genTiles(this.level, this.#isMercator, x, y, x, y)[0];
                tiles.push(r[k]);
              }
              selTiles.push(r[k]);
            }
          }
          tiles = selTiles;
        }
      }
    }

    /*
    console.log({
      level: this.level,
      totalObjs: this.children.length,
      tilesFound: tiles.length,
      tilesInView: tiles.filter(this.#isInView || (() => true)).length,
      levelTiles: this.#tilesMeta[this.level].length,
      fetched: this.#tilesMeta[this.level].filter(d => d.obj).length,
      loading: this.#tilesMeta[this.level].filter(d => d.loading).length,
    });
    */

    tiles
      .filter(d => !d.obj)
      .filter(this.#isInView || (() => true))
      .forEach(d => {
        const { x, y, lng, lat, latLen } = d;
        const lngLen = 360 / (2**this.level);

        if (!d.obj) {
          const width = lngLen * (1 - this.tileMargin);
          const height = latLen * (1 - this.tileMargin);
          const rotLng = deg2Rad(lng);
          const rotLat = deg2Rad(-lat);
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
          if (this.#isMercator) {
            const [y0, y1] = [lat + latLen / 2, lat - latLen / 2].map(lat => 0.5 - (lat / 180));
            convertMercatorUV(tile.geometry.attributes.uv, y0, y1);
          }

          d.obj = tile;
        }

        if (!d.loading) {
          d.loading = true;

          // Fetch tile image
          new TextureLoader().load(this.tileUrl(x, y, this.level), texture => {
            const tile = d.obj;
            if (tile) {
              texture.colorSpace = SRGBColorSpace;
              tile.material.map = texture;
              tile.material.color = null;
              tile.material.needsUpdate = true;
              this.add(tile);
            }
            d.loading = false;
          });
        }
      });
  }
}
