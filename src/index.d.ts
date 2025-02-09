import { Object3D, Camera } from 'three';

type TileUrlFn = (x: number, y: number, level: number) => string;

export interface ConfigOptions {
  tileUrl?: TileUrlFn;
  minLevel?: number;
  maxLevel?: number;
  mercatorProjection?: boolean;
}

declare class SlippyMapGlobe extends Object3D {
  constructor(radius: number, configOptions?: ConfigOptions);

  // Attributes
  tileUrl?: TileUrlFn;
  minLevel: number;
  maxLevel: number;
  thresholds: number[];
  level: number;
  tileMargin: number;
  curvatureResolution: number;

  // Methods
  updatePov(camera: Camera): void;
  clearTiles(): void;
}

export default SlippyMapGlobe;