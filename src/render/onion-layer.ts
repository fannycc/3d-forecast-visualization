import {
  Layer,
  project32,
  picking,
  type LayerProps,
  type PickingInfo,
  type UpdateParameters,
} from '@deck.gl/core';
import { Geometry, Model } from '@luma.gl/engine';
import type { Buffer, Texture } from '@luma.gl/core';
import type { Volume } from '../engine/types';
import { colorSprite, paletteNames, type Palette } from './colors';
import { patternAtlasPixels } from './patterns';
import type { ElevationGrid } from './relief';

/** Terrain-shaped time layers ("onion skins").
 *
 * Every sheet is one forecast time, drawn at that time's height in the cube and bent by the
 * terrain. Colours come from the nearest data cell, never interpolated. Terrain relief is
 * capped below the spacing between sheets, so sheets never intersect. */

type Props = LayerProps & {
  volume: Volume;
  grid: ElevationGrid;
  size: [number, number, number];
  /** Source time indices to draw, bottom to top. */
  sheets: number[];
  /** Cube units per metre of elevation. */
  unitsPerMetre: number;
  slices: [number, number, number];
  range: [number, number];
  palette: Palette;
  /** Ensemble spread per cell in the shown units; encoded exactly as in the voxel cube. */
  uncertainty?: Float32Array;
  uncertaintyMode?: 'off' | 'suppress' | 'hatch';
  uncertaintyScale?: number;
  /** Matching cells from SQL or an event search, in [time, y, x] order. */
  selectionMask?: Uint8Array | null;
  selectionStyle?: 'isolate' | 'paint';
  /** Colour that non-matching cells fade toward in paint mode. */
  muted?: [number, number, number];
  hideMissing?: boolean;
  /** Draw values as ink glyphs on paper instead of colours. */
  pattern?: boolean;
  onReady?: () => void;
};

const uniformBlock = `uniform onionUniforms {
  vec3 size;
  vec2 cut;
  vec2 counts;
  vec2 valueRange;
  float unitsPerMetre;
  float paletteIndex;
  float uncertaintyMode;
  float uncertaintyScale;
  float maskMode;
  vec3 muted;
  float hideMissing;
  float patternMode;
  float patternSize;
} onion;`;

const onionModule = {
  name: 'onion',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    size: 'vec3<f32>',
    cut: 'vec2<f32>',
    counts: 'vec2<f32>',
    valueRange: 'vec2<f32>',
    unitsPerMetre: 'f32',
    paletteIndex: 'f32',
    uncertaintyMode: 'f32',
    uncertaintyScale: 'f32',
    maskMode: 'f32',
    muted: 'vec3<f32>',
    hideMissing: 'f32',
    patternMode: 'f32',
    patternSize: 'f32',
  },
} as const;

const vs = `#version 300 es
in vec2 positions;
in float heights;
in vec2 instanceSheet;
out vec2 vUV;
out vec3 vWorld;
out float vHeight;
flat out float vTime;
void main() {
  vUV = positions;
  vHeight = heights;
  vTime = instanceSheet.x;
  vec3 p = vec3((positions - 0.5) * onion.size.xy, instanceSheet.y + heights * onion.unitsPerMetre);
  vWorld = p;
  geometry.worldPosition = p;
  // Any non-zero colour marks the vertex pickable; the cell is encoded in the fragment shader.
  geometry.pickingColor = vec3(1., 0., 0.);
  gl_Position = project_position_to_clipspace(p, vec3(0.), vec3(0.), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vec4 c = vec4(1.);
  DECKGL_FILTER_COLOR(c, geometry);
}`;

const fs = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D volumeTexture;
uniform sampler2D paletteTexture;
uniform sampler3D uncertaintyTexture;
uniform sampler3D selectionTexture;
uniform sampler2D patternTexture;
in vec2 vUV;
in vec3 vWorld;
in float vHeight;
flat in float vTime;
out vec4 fragColor;
void main() {
  if (vUV.x > onion.cut.x + 1e-5 || vUV.y < onion.cut.y - 1e-5) discard;
  ivec3 cell = ivec3(int(round(vUV.x * (onion.counts.x - 1.))), int(round(vUV.y * (onion.counts.y - 1.))), int(vTime));
  float value = texelFetch(volumeTexture, cell, 0).r;
  bool selected = onion.maskMode < .5 || texelFetch(selectionTexture, cell, 0).r > .5;
  if (onion.maskMode > .5 && onion.maskMode < 1.5 && !selected) discard;
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (normal.z < 0.) normal = -normal;
  // Gentle shading: enough to read the terrain, small enough not to pass for colder values.
  float shade = 0.88 + 0.14 * max(dot(normal, normalize(vec3(-0.5, 0.5, 0.7071))), 0.);
  if ((isnan(value) || isinf(value)) && onion.hideMissing > .5) discard;
  if (isnan(value) || isinf(value)) {
    fragColor = vec4(vec3(0.62) * shade, 1.);
  } else {
    float span = onion.valueRange.y - onion.valueRange.x;
    float scaled = clamp((value - onion.valueRange.x) / (span == 0. ? 1. : span), 0., 1.);
    float row = (onion.paletteIndex + .5) / float(textureSize(paletteTexture, 0).y);
    vec3 c = texture(paletteTexture, vec2(scaled, row)).rgb;
    // Mirrors vsupColor() in colors.ts and the voxel shader: 1 = suppress, 2 = hatch.
    if (onion.uncertaintyMode > .5 && picking.isActive < .5) {
      float spread = texelFetch(uncertaintyTexture, cell, 0).r;
      float scale = max(onion.uncertaintyScale, 1e-12);
      if (onion.uncertaintyMode < 1.5) {
        float band = (isnan(spread) || isinf(spread)) ? 3. : min(3., floor(3. * spread / scale));
        float bins = exp2(3. - band);
        float q = (min(floor(scaled * bins), bins - 1.) + .5) / bins;
        c = texture(paletteTexture, vec2(q, row)).rgb;
        c = mix(c, vec3(dot(c, vec3(.2126, .7152, .0722))), .85 * band / 3.);
      } else if (!(spread < scale) && mod(gl_FragCoord.x + gl_FragCoord.y, 7.) < 1.75) {
        c = mix(c, vec3(.06), .62);
      }
    }
    fragColor = vec4(c * shade, 1.);
  }
  if (!selected && picking.isActive < .5) {
    float g = dot(fragColor.rgb, vec3(.2126, .7152, .0722));
    fragColor.rgb = mix(vec3(g), onion.muted, .72);
  }
  // Patterned theme: a glyph per screen cell, chosen by the value (7 steps of ink).
  if (onion.patternMode > .5 && picking.isActive < .5) {
    float levels = 7.;
    float span = onion.valueRange.y - onion.valueRange.x;
    float scaled = clamp((value - onion.valueRange.x) / (span == 0. ? 1. : span), 0., 1.);
    float level = (isnan(value) || isinf(value)) ? 0. : min(levels - 1., floor(scaled * levels));
    vec2 cell = fract(gl_FragCoord.xy / onion.patternSize);
    float faint = selected ? 0. : 1.;
    fragColor.rgb = texture(patternTexture, vec2((level + cell.x) / levels, (faint + 1. - cell.y) / 2.)).rgb;
  }
  DECKGL_FILTER_COLOR(fragColor, geometry);
  if (picking.isActive > .5 && picking.isAttribute < .5) {
    int n = (cell.z * int(onion.counts.y) + cell.y) * int(onion.counts.x) + cell.x + 1;
    fragColor.rgb = vec3(n % 256, (n / 256) % 256, (n / 65536) % 256) / 255.;
  }
}`;

export class OnionLayer extends Layer<Props> {
  static layerName = 'ZarrSQLViewsOnionLayer';
  declare state: {
    model?: Model;
    sheetBuffer?: Buffer;
    texture?: Texture;
    uncertaintyTexture?: Texture;
    selectionTexture?: Texture;
    paletteTexture?: Texture;
    patternTexture?: Texture;
    reported?: boolean;
  };

  getNumInstances() {
    return Math.max(1, this.props.sheets?.length ?? 1);
  }

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, picking, onionModule] });
  }

  initializeState() {
    this.setState({
      patternTexture: this.context.device.createTexture({
        format: 'rgba8unorm',
        ...patternAtlasPixels(),
        mipLevels: 1,
        sampler: { minFilter: 'linear', magFilter: 'linear' },
      }),
      paletteTexture: this.context.device.createTexture({
        format: 'rgba8unorm',
        width: 256,
        height: paletteNames.length,
        data: new Uint8Array(colorSprite().data.buffer),
        mipLevels: 1,
        sampler: {
          minFilter: 'linear',
          magFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        },
      }),
    });
  }

  updateState({ props, oldProps }: UpdateParameters<this>) {
    if (props.grid !== oldProps.grid || !this.state.model) {
      this.state.model?.destroy();
      const { cols, rows, heights } = props.grid;
      const positions = new Float32Array(cols * rows * 2);
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          positions[(j * cols + i) * 2] = i / (cols - 1);
          positions[(j * cols + i) * 2 + 1] = j / (rows - 1);
        }
      const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let k = 0;
      for (let j = 0; j < rows - 1; j++)
        for (let i = 0; i < cols - 1; i++) {
          const a = j * cols + i;
          indices.set([a, a + 1, a + cols, a + 1, a + cols + 1, a + cols], k);
          k += 6;
        }
      const sheetBuffer = this.context.device.createBuffer({ data: new Float32Array([0, 0]) });
      const model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        geometry: new Geometry({
          topology: 'triangle-list',
          attributes: {
            positions: { size: 2, value: positions },
            heights: { size: 1, value: heights },
          },
          indices: { size: 1, value: indices },
        }),
        isInstanced: true,
        instanceCount: 1,
        bufferLayout: [{ name: 'instanceSheet', format: 'float32x2', stepMode: 'instance' }],
        parameters: { depthWriteEnabled: true, depthCompare: 'less-equal', cullMode: 'none' },
      });
      model.setAttributes({ instanceSheet: sheetBuffer });
      this.state.sheetBuffer?.destroy();
      this.setState({ model, sheetBuffer });
    }

    if (props.volume !== oldProps.volume || !this.state.texture) {
      this.state.texture?.destroy();
      const v = props.volume;
      const [depth, height, width] = v.shape;
      const texture = this.context.device.createTexture({
        dimension: '3d',
        format: 'r32float',
        width,
        height,
        depth,
        data: v.data instanceof Float32Array ? v.data : new Float32Array(v.data),
        mipLevels: 1,
        sampler: { minFilter: 'nearest', magFilter: 'nearest' },
      });
      this.setState({ texture, reported: false });
    }

    if (
      props.volume !== oldProps.volume ||
      props.uncertainty !== oldProps.uncertainty ||
      !this.state.uncertaintyTexture
    ) {
      this.state.uncertaintyTexture?.destroy();
      const u = props.uncertainty;
      const [depth, height, width] = u ? props.volume.shape : [1, 1, 1];
      this.setState({
        uncertaintyTexture: this.context.device.createTexture({
          dimension: '3d',
          format: 'r32float',
          width,
          height,
          depth,
          data: u ?? new Float32Array([0]),
          mipLevels: 1,
          sampler: { minFilter: 'nearest', magFilter: 'nearest' },
        }),
      });
    }

    if (
      props.volume !== oldProps.volume ||
      props.selectionMask !== oldProps.selectionMask ||
      !this.state.selectionTexture
    ) {
      this.state.selectionTexture?.destroy();
      const mask = props.selectionMask;
      const [depth, height, width] = mask ? props.volume.shape : [1, 1, 1];
      this.setState({
        selectionTexture: this.context.device.createTexture({
          dimension: '3d',
          format: 'r8unorm',
          width,
          height,
          depth,
          data: mask ?? new Uint8Array([255]),
          mipLevels: 1,
          sampler: { minFilter: 'nearest', magFilter: 'nearest' },
        }),
      });
    }

    const model = this.state.model!;
    if (
      props.sheets !== oldProps.sheets ||
      props.volume !== oldProps.volume ||
      props.grid !== oldProps.grid
    ) {
      const v = props.volume;
      const t0 = v.times[0],
        span = v.times.at(-1)! - t0 || 1;
      const data = new Float32Array(props.sheets.length * 2);
      props.sheets.forEach((t, i) => {
        data[i * 2] = t;
        data[i * 2 + 1] = ((v.times[t] - t0) / span - 0.5) * props.size[2];
      });
      this.state.sheetBuffer!.destroy();
      const sheetBuffer = this.context.device.createBuffer({
        data: data.length ? data : new Float32Array([0, 0]),
      });
      model.setAttributes({ instanceSheet: sheetBuffer });
      model.setInstanceCount(props.sheets.length);
      this.setState({ sheetBuffer });
    }
    model.setBindings({
      volumeTexture: this.state.texture!,
      paletteTexture: this.state.paletteTexture!,
      patternTexture: this.state.patternTexture!,
      uncertaintyTexture: this.state.uncertaintyTexture!,
      selectionTexture: this.state.selectionTexture!,
    });
  }

  draw() {
    const { model } = this.state;
    if (!model || !this.props.sheets.length) return;
    const { volume: v, slices, range, palette, size, unitsPerMetre } = this.props;
    const lon = v.lon.map((n) => (n - v.lon[0] + 360) % 360);
    const norm = (a: number[], i: number) =>
      a.length < 2 ? 0 : (a[i] - a[0]) / (a.at(-1)! - a[0]);
    model.shaderInputs.setProps({
      onion: {
        size,
        cut: [norm(lon, slices[0]), norm(v.lat, slices[1])],
        counts: [v.shape[2], v.shape[1]],
        valueRange: range,
        unitsPerMetre,
        paletteIndex: paletteNames.indexOf(palette),
        uncertaintyMode:
          this.props.uncertainty && this.props.uncertaintyMode === 'suppress'
            ? 1
            : this.props.uncertainty && this.props.uncertaintyMode === 'hatch'
              ? 2
              : 0,
        uncertaintyScale: this.props.uncertaintyScale ?? 1,
        maskMode: !this.props.selectionMask ? 0 : this.props.selectionStyle === 'paint' ? 2 : 1,
        muted: this.props.muted ?? [0.16, 0.18, 0.21],
        hideMissing: this.props.hideMissing ? 1 : 0,
        patternMode: this.props.pattern ? 1 : 0,
        patternSize: 11 * (window.devicePixelRatio || 1),
      },
    });
    if (model.draw(this.context.renderPass) && !this.state.reported) {
      this.state.reported = true;
      queueMicrotask(() => this.props.onReady?.());
    }
  }

  getPickingInfo({ info }: { info: PickingInfo }) {
    const v = this.props.volume;
    const n = info.index;
    if (n >= 0 && n < v.data.length) {
      const x = n % v.shape[2],
        y = Math.floor(n / v.shape[2]) % v.shape[1],
        t = Math.floor(n / (v.shape[2] * v.shape[1]));
      info.object = { x, y, t, value: v.data[n] };
    }

    return info;
  }

  finalizeState() {
    this.state.model?.destroy();
    this.state.sheetBuffer?.destroy();
    this.state.texture?.destroy();
    this.state.uncertaintyTexture?.destroy();
    this.state.selectionTexture?.destroy();
    this.state.paletteTexture?.destroy();
    this.state.patternTexture?.destroy();
  }
}
