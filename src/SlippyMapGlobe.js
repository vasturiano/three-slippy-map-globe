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

import { quadtree as d3Quadtree } from 'd3-quadtree';
import { octree as d3Octree } from 'd3-octree';

import { emptyObject } from "./utils/gc.js";
import { deg2Rad, polar2Cartesian, cartesian2Polar } from './utils/coordTranslate.js';
import { convertMercatorUV } from './utils/mercator.js';
import genLevel from "./utils/levelGenerator.js";

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
  thresholds = [8, 4, 2, 1, 1/2, 1/4, 1/8, 1/16, 1/32, 1/64, 1/128]; // in terms of radius units
  curvatureResolution = 5; // in degrees, affects number of vertices in tiles
  tileMargin = 0;
  get level() { return this.#level }
  set level(level) {
    if (!this.#tilesMeta[level]) this.#buildMetaLevel(level);

    const prevLevel = this.#level;
    this.#level = level;

    if (level === prevLevel || prevLevel === undefined) return; // nothing else to do

    // Bring layer to front
    this.#tilesMeta[level].forEach(d => d.obj && (d.obj.material.depthTest = true));

    this.#tilesMeta[prevLevel].forEach(prevLevel < level ?
      // push lower layers to background
      d => d.obj && (d.obj.material.depthTest = false) :
      // Remove upper layers
      d => {
        d.loading && (d.discard = true);
        d.fetched = false;
        if (d.obj) {
          this.remove(d.obj);
          emptyObject(d.obj);
          delete d.obj;
        }
      });

    this.#fetchNeededTiles();
  }

  // Public methods
  updatePov(camera) {
    if (!camera || !(camera instanceof Camera)) return;

    this.#camera = camera;

    const pov = camera.position.clone();
    const distToGlobeCenter = pov.distanceTo(this.getWorldPosition(new Vector3()));
    const cameraDistance = (distToGlobeCenter - this.#radius) / this.#radius; // in units of globe radius

    camera.updateMatrix();
    camera.updateMatrixWorld();
    const frustum = new Frustum();
    frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

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
      return d.hullPnts.some(pos =>
        frustum.containsPoint(pos.clone().applyMatrix4(this.matrixWorld))
      );
    }

    if (this.tileUrl) {
      const idx = this.thresholds.findIndex(t => t && t <= cameraDistance);
      this.level = idx < 0 ? this.thresholds.length : idx;
      this.#fetchNeededTiles();
    }
  }

  // Private attributes
  #radius;
  #isMercator;
  #level;
  #tilesMeta = {};
  #isInView;
  #camera;

  // Private methods
  #buildMetaLevel(level) {
    const levelMeta = this.#tilesMeta[level] = genLevel(level, this.#isMercator);

    if (level <= 8) { // octrees consume too much memory on higher levels, it's ok to use quadtrees for those as the distortion from the globe's surface is negligible
      levelMeta.forEach(d => d.centroid = polar2Cartesian(d.lat, d.lng, this.#radius));
      levelMeta.octree = d3Octree()
        .x(d => d.centroid.x)
        .y(d => d.centroid.y)
        .z(d => d.centroid.z)
        .addAll(levelMeta);
    } else {
      levelMeta.quadtree = d3Quadtree()
        .x(d => d.lng)
        .y(d => d.lat)
        .addAll(levelMeta);
    }
  }

  #fetchNeededTiles(){
    if (!this.tileUrl || this.level === undefined || !this.#tilesMeta.hasOwnProperty(this.level)) return;

    // Safety if can't check in view tiles for higher levels (level 6 = 4096 tiles)
    if (!this.#isInView && this.level > 6) return;

    let tiles = this.#tilesMeta[this.level];
    if (this.#camera) {
      // Pre-select points close to the camera using an octree for improved performance
      const povPos = this.worldToLocal(this.#camera.position.clone());

      if (tiles.octree) { // Octree based on 3d positions is more accurate
        const DISTANCE_CHECK_FACTOR = 3; // xyz straight-line distance, relative to camera absolute altitude
        const povPos = this.worldToLocal(this.#camera.position.clone());
        const searchRadius = (povPos.length() - this.#radius) * DISTANCE_CHECK_FACTOR;
        tiles = tiles.octree.findAllWithinRadius(...povPos, searchRadius);
      } else if (tiles.quadtree) { // Fallback to quadtree, for upper levels
        const DISTANCE_CHECK_FACTOR = 180; // in degrees on the globe surface, relative to camera altitude in globe radius units
        const povCoords = cartesian2Polar(povPos);
        const searchRadius = (povCoords.r / this.#radius - 1) * DISTANCE_CHECK_FACTOR;
        const lngRange = [povCoords.lng - searchRadius, povCoords.lng + searchRadius];
        const latRange = [povCoords.lat - searchRadius, povCoords.lat + searchRadius];
        const result = [];
        tiles.quadtree.visit((node, lng1, lat1, lng2, lat2) => {
          if (!node.length) {
            do {
              const d = node.data;
              if (Math.sqrt((povCoords.lng - d.lng)**2 + (povCoords.lat - d.lat)**2) <= searchRadius) {
                result.push(d);
              }
            } while (node = node.next);
          }
          return lng1 > lngRange[1] || lat1 > latRange[1] || lng2 < lngRange[0] || lat2 < latRange[0];
        });
        tiles = result;
      }
    }

    tiles
      .filter(d => !d.fetched && !d.discard)
      .filter(this.#isInView || (() => true))
      .forEach(d => {
        // Fetch tile
        d.fetched = true;
        d.loading = true;

        const lngLen = 360 / (2**this.level);
        const { x, y, lng, lat, latLen } = d;

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
        const [y0, y1] = [lat + latLen / 2, lat - latLen / 2].map(lat => 0.5 - (lat / 180));
        this.#isMercator && convertMercatorUV(tile.geometry.attributes.uv, y0, y1);

        new TextureLoader().load(this.tileUrl(x, y, this.level), texture => {
          if (!d.discard) {
            texture.colorSpace = SRGBColorSpace;
            tile.material.map = texture;
            tile.material.color = null;
            tile.material.needsUpdate = true;

            this.add(tile);
          }
          d.loading = false;
          d.discard = false;
        });

        d.obj = tile;
      });
  }
}
