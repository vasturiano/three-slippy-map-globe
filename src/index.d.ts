import { Object3D, Camera } from 'three';

type TileUrlFn = (x: number, y: number, level: number) => string;

export interface ConfigOptions {
  tileUrl?: TileUrlFn;
  mercatorProjection?: boolean;
}

declare class SlippyMapGlobe extends Object3D {
  constructor(radius: number, configOptions?: ConfigOptions);

  // Attributes
  tileUrl?: TileUrlFn;
  thresholds: number[];
  level: number;
  tileMargin: number;
  curvatureResolution: number;

  // Methods
  updatePov(camera: Camera): void;
}

export default SlippyMapGlobe;