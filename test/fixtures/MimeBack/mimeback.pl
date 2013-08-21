#!/usr/bin/perl

$BaseDir = '/usr/local/wn/mimetest/messages-directory';

# Where to send internal error reports
$OwnerAddr = 'nobody@imc.org';

# Return address put on the messages returned. This might have been
#   defined outside of the program, so first check if it is blank.
if($RetAddr eq '')
	{ $RetAddr = 'Mimeback Autoresponder <mimetest-human@imc.org>' }

# $WhereSendmail is the path to sendmail on your system. (This should
#    in theory also work with smail, but there are no guarantees.)
#    This gets turned into the correct pipe command in the program.
#    This path *must* be a full path to the sendmail program, and
#    not rely on any PATH environmental variables.
$WhereSendmail = '/usr/sbin/sendmail';

# Create the $MailOut string after checking on $WhereSendmail
if(substr($WhereSendmail, 0, 1) ne '/')
	{ die "\$WhereSendmail *must* be a real path to the sendmail binary.\n" }
unless(-x $WhereSendmail)
	{ die "\$WhereSendmail, which is $WhereSendmail, does not exist or " .
		"is not executable.\n" }
$MailOut = '| ' . $WhereSendmail . ' -bm -t';

$HelpText = &TheHelp;  # Just call the subroutine

# Get the message sent to us. @TheInput will be treated like STDIN
#    Also check if the message is too long as it is read
@TheInput = ();
while(<STDIN>) { push(@TheInput, $_) }

# Is this a broken message from the user?
if (@TheInput < 3) { exit }

open(LOG, ">>/usr/local/wn/mimetest/Log") or die "Could not append to log\n";
print LOG join('', @TheInput), "\n\n";

($UserAddr, $UserSubject, @TheMessage) = &GetAddrAndSubject(@TheInput);
$StripUser = &StripAddr($UserAddr);
$StripRet = &StripAddr($RetAttr);
if($StripUser eq $StripRet)
	{ &ErrorToOwner("Someone sent a message with $RetAttr as the address.") }

# Check if the subject is a valid file

@WantedFiles = split(/ /, $UserSubject);

if($#WantedFiles == -1) { &ErrorToSender("You must specify the messages " .
	"you want in the subject of your message.") }
if(index(uc($UserSubject), 'HELP') > -1 ) { &ErrorToSender('') }
for($i = 0; $i <= $#WantedFiles; $i++) {
	$WantedFiles[$i] = uc($WantedFiles[$i]);
	next if(-r "$BaseDir/$WantedFiles[$i]");
	if($WantedFiles[$i] eq 'ALL') {
		# Make the array all the files and stop looking for files
		chdir($BaseDir);
		@WantedFiles = sort(glob('*'));
		last;
	}
	# There's a special case for messsage/partial
	if($WantedFiles[$i] eq 'EM6.1') {
		$WantedFiles[$i] = 'EM6.1-1';
		push(@WantedFiles, 'EM6.1-2');
		next;
	}
	&ErrorToSender("The message $WantedFiles[$i] is not a valid choice.");
}

foreach $File (@WantedFiles) {
	$WholeFile = '';
	open(THEFILE, "$BaseDir/$File") or
		&ErrorToOwner("Hmm: couldn't open $BaseDir/$File in last loop.");
	while(<THEFILE>) { $WholeFile .= $_ }
	$WholeFile =~ s/\(requester of the test\)/$UserAddr/g;
	&SendAMessage($WholeFile);
	sleep(1);
}

exit 0;

sub GetAddrAndSubject{
	my @MyInput = @_;
	my ($AllHeaders, $Left, $Right, $UserPref, $LastLT, $LastGT, $Subject);
	my (@HeaderLines, $i, $GivenAddr, $HadBadChar, @TheBadChars, @EachLet);

	$AllHeaders = '';
	while(defined($_ = shift(@MyInput))) {
		# Stop when you get to the blank line that separates the headers and body
		if (/^$/) {last}
		# Ignore the envelope From_ header
		elsif (/^From /) {next}
		# If it starts with a non-whitespace character, it's a new header
		elsif (/^\S/) {
			($Left, $Right) = split(/:[ \t]*/, $_, 2);
			$Left =~ tr/A-Z/a-z/; # We want the header name in lowercase
			$AllHeaders .= "$Left: $Right"; # Put it back together with one space
		}
		# It must be a continuation line
		else {$AllHeaders .= $_ }
	}
	# Merge any continuation lines with their headers
	$AllHeaders =~ s/\n\s+/ /g;

	# Get the user's address from the message's headers
	#   The order of preference is:
	#   1) reply-to:
	#   2) from:
	#   3) apparently-from:
	# A lower $UserPref is a better address to use
	$GivenAddr = ''; $UserPref = 10; $Subject = '';
	# Split the $AllHeader string into an array of lines
	@HeaderLines = split(/^/,$AllHeaders);
	for($i=0; $i<@HeaderLines; $i++) {
		($Left, $Right) = split(/: /, $HeaderLines[$i], 2);
		if ($Left eq 'reply-to')
			{$GivenAddr = $Right; $UserPref = 1}
		elsif (($Left eq 'from') && ($UserPref > 2))
			{$GivenAddr = $Right; $UserPref = 2}
		elsif (($Left eq 'apparently-from') && ($UserPref > 3))
			{$GivenAddr = $Right; $UserPref = 3}
		elsif ($Left eq 'subject') { $Subject = $Right; chomp($Subject) }
	}
	if($Subject eq '') { &ErrorToSender("The was no subject line.") }
	if($Subject eq "\n") { &ErrorToSender("The subject was blank.") }

	if($GivenAddr eq '') { &ErrorToOwner("The was no user address.") }
	chop($GivenAddr);  # Remove the LF from the address

	# Keep $GivenAddr around for error messages outside this subroutine
	$LocalUserAddr = $GivenAddr;

	# Now parse the user address for various forms
	# If it is just "addr-spec", it's already OK
	if (index($LocalUserAddr, ' ') > -1) {
		# Check for "addr-spec (comment)"
		($Left, $Right) = split(/ /, $LocalUserAddr, 2);
		if (index($Right, '(') >-1 ) {
			# Removed determing InsideUserAddr
			# $InsideUserAddr = $Left;
			}
		# Look for "phrase (comment) <addr-spec>". $LastLT is the position
		#	of the last '<', $LastGT is the position of the last '>'.
		else {
			$LastLT = rindex($LocalUserAddr, '<');
			if ($LastLT >= 0) {
				# Removed determining InsideUserAddr
				# $LastGT = index($LocalUserAddr, '>', $LastLT);
				# $InsideUserAddr=substr($LocalUserAddr, $LastLT+1, $LastGT-$LastLT-1);
			}
			else { &ErrorToOwner("The given address $GivenAddr seems wrong.\n") }
		}
	}
	# Check for any control characters and die if found
	$HadBadChar = grep(/[^\x20-\x7e]/, $LocalUserAddr);
	if($HadBadChar) {
		@EachLet = split(//, $LocalUserAddr);
		@TheBadChars = grep(/[^\x20-\x7e]/, @EachLet);
		$i = ord($TheBadChars[0]);
		&ErrorToOwner("The address, $LocalUserAddr, had $HadBadChar bad " .
			"characters:\nThe first was (decimal) $i");
	}
	return($LocalUserAddr, $Subject, @MyInput);
}

sub StripAddr {
	my $InAddr = shift(@_);
	my ($Left, $Right, $LastLT, $LastGT);
	if (index($InAddr, ' ') > -1) {
		# Check for "addr-spec (comment)"
		($Left, $Right) = split(/ /, $InAddr, 2);
		if (index($Right, '(') >-1 )
			{ $InsideUserAddr = $Left }
		# Look for "phrase (comment) <addr-spec>". $LastLT is the position
		#	of the last '<', $LastGT is the position of the last '>'.
		else {
			$LastLT = rindex($InAddr, '<');
			if ($LastLT >= 0) {
				$LastGT = index($InAddr, '>', $LastLT);
				$InsideUserAddr=substr($InAddr, $LastLT+1, $LastGT-$LastLT-1);
			}
			else {
				&ErrorToOwner("The address -- $InAddr -- seems wrong.\n");
			}
		}
	}
	else { $InsideUserAddr = $InAddr }
	return($InsideUserAddr);
}

sub ErrorToOwner {
	local($TheError) = @_;
	$OutMessage = "To: $OwnerAddr\nFrom: $RetAddr\n" .
		"Subject: Error report from mimeback\n\n" .
		"mimeback aborted with the error:\n$TheError\n";
	&SendAMessage($OutMessage);
	exit 0;  # Quit here and don't process any more input
}

sub ErrorToSender {
	local($TheError) = @_;
	$OutMessage = "To: $UserAddr\nFrom: $RetAddr\n" .
		"Subject: Report from mimeback\n" .
		"MIME-Version: 1.0\nContent-Type: text/plain; charset=iso-8859-1" .
		"\n\n$TheError";
	&SendAMessage("$OutMessage\nHelp for the mime tester:\n\n$HelpText");
	exit 0;  # Quit here and don't process any more input
}

sub SendAMessage{
	local($TheMessage) = @_;
	open(OUT, $MailOut) || die "Help! I can't mail!\n";
	print OUT $TheMessage;
	close(OUT);
}

sub TheHelp {
$TheRet = <<EOF;
To receive a specific MIME-encoded message, put the name by itself on
the subject line of a message to mimetest\@imc.org. The body of the
message you send to mimetest\@imc.org is ignored.

To contact a person about the mimetest suite, send a message to
mimetest-human\@imc.org.

The mimetest suite originated with Patrik Fältström. Patrik handed over
control of the suite to IMC but still helps with the maintenance.

All messages are tested on several architectures, and on several MIME
clients before they were put in this test suite . Of course, there may
still be errors in the messages. If you think you have found such
errors, please send mail to mimetest-human\@imc.org and let us know.

NOTE: IMC does not take any responsibility for damages on your computer,
your software or loss of work when reading these messages. You should
save your work and quit all other applications before reading a mimetest
message. A message might start an external viewer which crashes your
computer, so even if your mail reader is stable, a crash can still
happen.

You can order the following tests. To request a test, put the name of
the test in the Subject of the request message.

Basic MIME functionality
========================
M1      MIME-Version: 1.0
M2      Content-Type: text/plain with Content-Transfer-Encoding: base64
M3-1    Content-Type: application/x-paf (should not be shown to the user)
M3-2    Content-Type: text/plain
M4.1.1  Content-Type: text/plain; charset="US-ASCII"
M4.1.2  Content-Type: text/plain; charset="X-PAF"
M4.1.3  Content-Type: text/plain; charset="ISO-8859-7"
M4.1.4  Content-Type: text/x-paf
M4.2.1  Content-Type: message/rfc822
M4.3.1  Content-Type: multipart/mixed; boundary=this_is_a_boundary
M4.3.2  Content-Type: multipart/alternative; boundary=this_is_a_boundary
M4.3.3  Content-Type: multipart/x-foo; boundary=this_is_a_boundary
M4.4.1  Content-Transfer-Encoding: base64
M5      Content-Type: X-PAF

Extra functionality needed in Sweden
====================================
S1      Content-Type: text/plain; charset=iso-8859-1
S2      RFC-1522
S2-2    RFC-1522

Extra MIME functionality
========================
EM1.1.1 Content-Type: text/plain; charset=SEN_850200_B
EM1.1.2 Content-Type: text/plain; charset=ISO-2022-JP-2
EM1.1.2-GIF is an image showing the test EM1.1.2
EM1.2   Content-Type: text/enriched
EM2.1   Content-Type: image/gif
EM2.2   Content-Type: image/jpeg
EM2.3   Content-Type: image/tiff
EM3.1   Content-Type: audio/basic
EM4.1   Content-Type: application/msword
EM4.2   Content-Type: application/postscript
EM5.1   Content-Type: multipart/appledouble
EM5.2   Content-Type: multipart/report
EM6.1    Content-Type: message/partial
EM7.1    Content-Type: video/mpeg
EOF
return $TheRet;
}