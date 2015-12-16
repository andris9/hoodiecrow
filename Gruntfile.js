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

		// give ability to run individual tests
		grunt.registerTask('test', function() {
		  var tests = Array.prototype.slice.call(arguments, 0).map(function(test) {
		    return 'tests/' + test + '.js';
		  });
		  if (tests.length > 0) {
				grunt.config('nodeunit.all', tests);
		  }
		  grunt.task.run('nodeunit');
		});

};