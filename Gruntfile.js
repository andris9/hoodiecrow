"use strict";

module.exports = function(grunt) {

    // Project configuration.
    grunt.initConfig({
        pkg: grunt.file.readJSON("package.json"),
        jshint: {
            all: ["Gruntfile.js", "lib/**/*.js", "index.js"],
            options: {
                jshintrc: ".jshintrc"
            }
        },
        nodeunit: {
            all: ["tests/*.js"]
        }
    });

    // Load the plugin that provides the "uglify" task.
    grunt.loadNpmTasks("grunt-contrib-jshint");
    grunt.loadNpmTasks("grunt-contrib-nodeunit");

    // Default task(s).
    grunt.registerTask("default", ["jshint", "nodeunit"]);

};