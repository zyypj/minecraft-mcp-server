// BuildEngine Paper plugin — Gradle Kotlin DSL build script.
//
// ENVIRONMENT NOTE: this scaffold targets Java 21 + Paper 1.21.x and has NOT been
// compiled in the authoring environment (which only had Java 8 and no Gradle).
// Build it on a machine with a JDK 21 + Gradle (or the wrapper) available.
//
// Why NO `paperweight-userdev`: this plugin uses only the Bukkit/Paper API plus the
// FAWE/WorldEdit API. It never touches raw NMS, so the mapping/deobfuscation machinery
// of paperweight is pure overhead here. If a future feature genuinely needs NMS, add
// paperweight-userdev then (and confirm at M1, per §3.1).

plugins {
    java
    // Shadow (GradleUp maintained fork) — fat-jar + relocation so the embedded
    // Jetty/Javalin/Jackson do not clash with the server's or other plugins' copies (§3.1).
    id("com.gradleup.shadow") version "8.3.5"
}

group = "com.mcbuild"
version = "0.1.0"

java {
    toolchain {
        // Paper 1.21.x requires Java 21. Gradle will locate (or auto-provision) a JDK 21.
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    mavenCentral()
    // Paper API
    maven("https://repo.papermc.io/repository/maven-public/") { name = "papermc" }
    // WorldEdit / FastAsyncWorldEdit
    maven("https://maven.enginehub.org/repo/") { name = "enginehub" }              // WorldEdit
    maven("https://mvn.intellectualsites.com/content/groups/public/") {            // FastAsyncWorldEdit
        name = "intellectualsites"
    }
}

dependencies {
    // --- Provided by the server at runtime (do NOT shade) ---
    // Bump the exact patch to the pinned MC version at M1 (§11 #2 — track the latest 1.21.x Paper+FAWE ship).
    compileOnly("io.papermc.paper:paper-api:1.21.8-R0.1-SNAPSHOT")

    // --- FAWE / WorldEdit — provided by the FastAsyncWorldEdit plugin (softdepend); compileOnly ---
    // Coordinates chosen (VERIFY/BUMP at M1 to match the pinned MC patch):
    //   WorldEdit Bukkit API : com.sk89q.worldedit:worldedit-bukkit  (EngineHub repo)
    //   FAWE Bukkit impl     : com.fastasyncworldedit:FastAsyncWorldEdit-Bukkit (IntellectualSites repo)
    compileOnly("com.sk89q.worldedit:worldedit-bukkit:7.3.8")
    compileOnly("com.fastasyncworldedit:FastAsyncWorldEdit-Bukkit:2.13.0")

    // --- Embedded HTTP + WebSocket bridge (Jetty under the hood) + JSON — SHADED & RELOCATED ---
    implementation("io.javalin:javalin:6.6.0")              // Javalin 6 (embedded Jetty 11), Java 17+
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.2")
}

tasks.shadowJar {
    // Make the shaded jar the primary artifact (drop the "-all" classifier).
    archiveClassifier.set("")

    // §3.1 — relocate the three embedded stacks the design calls out explicitly.
    relocate("org.eclipse.jetty", "com.mcbuild.buildengine.shaded.jetty")
    relocate("io.javalin", "com.mcbuild.buildengine.shaded.javalin")
    relocate("com.fasterxml.jackson", "com.mcbuild.buildengine.shaded.jackson")

    // Javalin 6 also brings slf4j + a Kotlin stdlib transitively. They rarely clash on a
    // Paper server, but relocate them too if you hit LinkageError/ClassCastException at load:
    // relocate("kotlin", "com.mcbuild.buildengine.shaded.kotlin")
    // relocate("org.slf4j", "com.mcbuild.buildengine.shaded.slf4j")

    mergeServiceFiles()
}

// `gradle build` should produce the shaded jar you drop into plugins/.
tasks.named("build") { dependsOn(tasks.shadowJar) }

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.compilerArgs.add("-parameters") // keep record/param names for Jackson + reflection
}
