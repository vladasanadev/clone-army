"use strict";
(() => {
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  function layout(count, size, spread, amount = 1) {
    count = count === 5 ? 5 : 3;
    size = clamp(Number(size) || .78, .45, 1);
    spread = clamp(Number(spread) || .32, .15, .43);
    amount = clamp(amount, 0, 1);
    const offsets = count === 5 ? [-1, -.5, .5, 1, 0] : [-1, 1, 0];
    return offsets.map(offset => ({
      x: .5 + offset * spread * amount,
      scale: 1 + ((offset === 0 ? Math.min(1, size + .10) : size * (count === 5 ? .82 : 1)) - 1) * amount,
      alpha: offset === 0 ? 1 : amount,
      offset
    }));
  }
  class Renderer {
    constructor(width, height) {
      this.width = width; this.height = height; this.ready = false;
      this.sprite = document.createElement("canvas");
      this.sprite.width = width; this.sprite.height = height;
      this.ctx = this.sprite.getContext("2d");
      this.maskCanvas = document.createElement("canvas");
      this.center = .5;
    }
    update(frame, mask) {
      const { width, height, mask: alpha } = mask;
      if (!width || !height || alpha.length !== width * height) throw new Error("Invalid silhouette");
      this.maskCanvas.width = width; this.maskCanvas.height = height;
      const mc = this.maskCanvas.getContext("2d");
      const image = mc.createImageData(width, height);
      let mass = 0, sumX = 0;
      for (let i = 0; i < alpha.length; i++) {
        const a = alpha[i];
        image.data[i * 4 + 3] = a;
        if (a > 140) { mass++; sumX += i % width; }
      }
      mc.putImageData(image, 0, 0);
      if (mass > width * height * .01) {
        const center = sumX / mass / width;
        this.center = this.ready ? this.center * .8 + center * .2 : center;
      }
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(frame, 0, 0, this.width, this.height);
      this.ctx.globalCompositeOperation = "destination-in";
      this.ctx.drawImage(this.maskCanvas, 0, 0, this.width, this.height);
      this.ctx.globalCompositeOperation = "source-over";
      this.ready = true;
    }
    render(ctx, background, options, amount) {
      const w = this.width, h = this.height;
      ctx.save();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(background, 0, 0, w, h);
      for (const item of layout(options.count, options.size, options.spread, amount)) {
        ctx.globalAlpha = item.alpha;
        // Bottom-aligned cutouts, person center follows their actual camera position.
        const x = (item.x - this.center * item.scale) * w;
        const y = h * (1 - item.scale);
        ctx.drawImage(this.sprite, x, y, w * item.scale, h * item.scale);
      }
      ctx.restore();
    }
    dispose() { this.ready = false; this.sprite.width = this.maskCanvas.width = 1; }
  }
  globalThis.CloneArmyRenderer = { Renderer, layout };
})();
