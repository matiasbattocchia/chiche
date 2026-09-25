import { burst, flash, glow, kit, next, Phaser, pop, prize, sfx, squash, startGame } from "kit";
import meta from "./game.json" with { type: "json" };

const W = 960, H = 540;

class Boot extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  create() {
    // Textures drawn in code: no asset files needed to get going.
    const g = this.add.graphics();
    g.fillStyle(0xffd60a).fillPoints(starPoints(24, 10, 5), true);
    g.generateTexture("star", 48, 48).clear();
    g.fillStyle(0xbc6c25).fillRoundedRect(0, 0, 160, 36, 12);
    g.generateTexture("basket", 160, 36).destroy();
    next(this, "Title");
  }
}

class Title extends Phaser.Scene {
  constructor() {
    super("Title");
  }

  create() {
    this.add.text(W / 2, H / 2 - 60, `${meta.emoji} ${meta.title}`, big(64)).setOrigin(0.5);
    const play = this.add.text(W / 2, H / 2 + 60, "▶ ¡Jugar!", big(48)).setOrigin(0.5);
    this.tweens.add({ targets: play, scale: 1.1, yoyo: true, repeat: -1, duration: 500 });
    const go = () => {
      sfx(this, "click");
      this.scene.start("Play");
    };
    this.input.keyboard!.once("keydown-SPACE", go);
    this.input.once("pointerdown", go);
    this.input.gamepad!.once("down", go);
  }
}

class Play extends Phaser.Scene {
  basket!: Phaser.Physics.Arcade.Image;
  stars!: Phaser.Physics.Arcade.Group;
  counter!: Phaser.GameObjects.Text;
  keys!: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() {
    super("Play");
  }

  get caught() {
    return (kit.save.data.caught as number) ?? 0;
  }

  create() {
    this.keys = this.input.keyboard!.createCursorKeys();
    this.cameras.main.filters.internal.addVignette(0.5, 0.5, 0.9, 0.3);
    this.basket = this.physics.add.image(W / 2, H - 40, "basket").setImmovable(true);
    this.basket.setCollideWorldBounds(true);
    this.stars = this.physics.add.group();
    this.counter = this.add.text(20, 16, "", big(40));
    this.count(this.caught); // from the save: a reload keeps the stars

    this.physics.add.overlap(this.basket, this.stars, (_b, s) => {
      const star = s as Phaser.Physics.Arcade.Image;
      burst(this, star.x, star.y, { tint: 0xffd60a });
      star.destroy();
      this.catch();
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.basket.x = p.x);
    this.drop();
  }

  /** One try per star: caught or missed. The difficulty sets how fast and how wide. */
  drop() {
    const d = kit.difficulty;
    const x = Phaser.Math.Between(60, W - 60);
    const star = this.stars.create(x, -30, "star") as Phaser.Physics.Arcade.Image;
    star.setVelocityY(d.pick(140, 420)).setAngularVelocity(90);
    pop(star);
    glow(star, 0xfff3b0);
    this.basket.setScale(d.pick(1.4, 0.7), 1);
  }

  catch() {
    kit.difficulty.trial(true);
    sfx(this, "coin");
    squash(this.basket);
    this.count(this.caught + 1);
    prize("star");
    if (this.caught % 5 === 0) this.fireworks();
    this.time.delayedCall(400, () => this.drop());
  }

  miss(star: Phaser.Physics.Arcade.Image) {
    star.destroy();
    kit.difficulty.trial(false);
    sfx(this, "miss");
    this.time.delayedCall(600, () => this.drop());
  }

  count(n: number) {
    kit.save.data.caught = n;
    this.counter.setText(`⭐ ${n}`);
  }

  fireworks() {
    prize("fireworks");
    sfx(this, "win");
    flash(this, 0xfff3b0);
    burst(this, W / 2, H / 2, { texture: "star", count: 40, speed: 400 });
  }

  override update() {
    const pad = this.input.gamepad?.pad1;
    const dx = (this.keys.left.isDown || pad?.left ? -1 : 0) + (this.keys.right.isDown || pad?.right ? 1 : 0);
    this.basket.setVelocityX(dx * 600);
    for (const star of this.stars.getChildren() as Phaser.Physics.Arcade.Image[]) {
      if (star.y > H + 30) this.miss(star);
    }
  }
}

function big(size: number): Phaser.Types.GameObjects.Text.TextStyle {
  return { fontFamily: "system-ui, sans-serif", fontSize: `${size}px`, fontStyle: "bold", color: "#fff", stroke: "#000", strokeThickness: 6 };
}

function starPoints(outer: number, inner: number, n: number) {
  return Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer, a = (Math.PI * i) / n - Math.PI / 2;
    return new Phaser.Math.Vector2(24 + r * Math.cos(a), 24 + r * Math.sin(a));
  });
}

startGame(meta, [Boot, Title, Play], { width: W, height: H });
