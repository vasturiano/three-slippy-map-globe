import { scaleLinear } from 'd3-scale';
import { geoMercatorRaw } from 'd3-geo';

const yMercatorScale = y => 1 - (geoMercatorRaw(0, (0.5 - y) * Math.PI)[1] / Math.PI + 1) / 2;
const yMercatorScaleClamped = y => Math.max(0, Math.min(1, yMercatorScale(y)));
const yMercatorScaleInvert = y => 0.5 - geoMercatorRaw.invert(0, (2 * (1 - y) - 1) * Math.PI)[1] / Math.PI;

const convertMercatorUV = (uvs, y0 = 0, y1 = 1) => {
  const offsetScale = scaleLinear().domain([1, 0]).range([y0, y1]).clamp(true);
  const revOffsetScale = scaleLinear().domain([yMercatorScaleClamped(y0), yMercatorScaleClamped(y1)]).range([1, 0]).clamp(true);
  const scale = v => revOffsetScale(yMercatorScaleClamped(offsetScale(v)));

  const arr = uvs.array;
  for (let i = 0, len = arr.length; i < len; i+=2) {
    arr[i+1] = scale(arr[i+1]);
  }
  uvs.needsUpdate = true;
}

export { yMercatorScale, yMercatorScaleInvert, convertMercatorUV }