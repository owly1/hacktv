/* Approximate land cover around the configured UTSC site, for the spread
   model's infrastructure/fuel brake (docs/FLEET_MODEL.md §3).
   factor < 1 slows projected growth through the zone (buildings, pavement,
   water); factor > 1 speeds it (continuous brush/ravine fuel). factor ≈ 0
   is a hard barrier — the projected zone pinches around it rather than
   washing over.
   Coordinates are hand-authored to ~30 m: an illustrative site map, NOT a
   surveyed fuel map. Everything outside these polygons defaults to factor 1. */
(function(root) {
  const zones = [
    {name: 'Instructional Centre', kind: 'building', factor: .05, polygon: [
      [43.78655, -79.18995], [43.78715, -79.18995], [43.78715, -79.18935], [43.78655, -79.18935]]},
    {name: 'Sam Ibrahim Building', kind: 'building', factor: .05, polygon: [
      [43.78610, -79.19245], [43.78675, -79.19245], [43.78675, -79.19185], [43.78610, -79.19185]]},
    {name: 'Student residences', kind: 'building', factor: .08, polygon: [
      [43.78845, -79.19210], [43.78895, -79.19210], [43.78895, -79.19140], [43.78845, -79.19140]]},
    {name: 'Ellesmere Road', kind: 'paved', factor: .12, polygon: [
      [43.78555, -79.1960], [43.78585, -79.1960], [43.78585, -79.1850], [43.78555, -79.1850]]},
    {name: 'North parking lot', kind: 'paved', factor: .15, polygon: [
      [43.78745, -79.19410], [43.78805, -79.19410], [43.78805, -79.19230], [43.78745, -79.19230]]},
    {name: 'East parking lot', kind: 'paved', factor: .15, polygon: [
      [43.78490, -79.18680], [43.78540, -79.18680], [43.78540, -79.18440], [43.78490, -79.18440]]},
    {name: 'Highland Creek ravine', kind: 'fuel', factor: 1.35, polygon: [
      [43.7860, -79.18620], [43.7896, -79.18620], [43.7896, -79.18320], [43.7860, -79.18320]]},
    {name: 'North woodlot', kind: 'fuel', factor: 1.25, polygon: [
      [43.7879, -79.19010], [43.7890, -79.19010], [43.7890, -79.18720], [43.7879, -79.18720]]},
  ];
  root.BoscoFuels = {zones};
  if (typeof module !== 'undefined') module.exports = root.BoscoFuels;
})(typeof globalThis !== 'undefined' ? globalThis : this);
