function polar2Cartesian(lat, lng, r) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return {
    x: r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta)
  };
}

function cartesian2Polar({ x, y, z }) {
  const r = Math.sqrt(x*x + y*y + z*z);
  const phi = Math.acos(y / r);
  const theta = Math.atan2(z, x);

  return {
    lat: 90 - phi * 180 / Math.PI,
    lng: 90 - theta * 180 / Math.PI - (theta < -Math.PI / 2 ? 360 : 0), // keep within [-180, 180] boundaries
    r
  }
}

function deg2Rad(deg) { return deg * Math.PI / 180; }
function rad2Deg(rad) { return rad / Math.PI * 180; }

export { polar2Cartesian, cartesian2Polar, rad2Deg, deg2Rad };